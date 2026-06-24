import { logAlignmentConflict, logAlignmentMessage, logPhaseStart } from '@/lib/memory/session-log'
import { estimateTokens } from '@/lib/utils/tokens'
import { retryWithTimeout, TIMEOUT_DEFAULT_MS } from '@/lib/utils/retry'
import { generateId } from '@/lib/utils'
import type {
  AlignmentMessage,
  AlignmentResult,
  ModelAdapter,
  Question,
  SSEEvent,
  ThinkingOutput,
} from '@/types'

// Architecture rule: max 2 alignment rounds — enforced here, not in adapters.
const MAX_ALIGNMENT_ROUNDS = 2

// Conflict signal words: if a model's position contains these, it flagged a mismatch.
const CONFLICT_SIGNALS = [
  'conflict', 'disagree', 'mismatch', 'inconsistent', 'incompatible',
  'but i think', 'different approach', 'contradicts',
]

function hasConflictSignal(position: string): boolean {
  const lower = position.toLowerCase()
  return CONFLICT_SIGNALS.some(s => lower.includes(s))
}

function detectMismatch(
  primaryMsg:  AlignmentMessage,
  reviewerMsg: AlignmentMessage,
): boolean {
  // Either model flagged a conflict in its position
  if (hasConflictSignal(primaryMsg.position) || hasConflictSignal(reviewerMsg.position)) return true

  // Understood_as differ significantly in length (rough proxy for divergent interpretation)
  const pa = primaryMsg.understood_as
  const ra = reviewerMsg.understood_as
  const longer  = Math.max(pa.length, ra.length)
  const shorter = Math.min(pa.length, ra.length)
  if (longer > 0 && shorter / longer < 0.4) return true

  return false
}

/**
 * Deduplicate questions from both thinking outputs.
 * Two questions are considered duplicates if their normalized texts are
 * 80%+ similar (same leading substring length / longer string).
 */
function deduplicateQuestions(questions: Question[]): Question[] {
  const seen: Question[] = []
  for (const q of questions) {
    const norm = q.text.toLowerCase().trim()
    const isDup = seen.some(s => {
      const sn    = s.text.toLowerCase().trim()
      const longer  = Math.max(norm.length, sn.length)
      const shorter = Math.min(norm.length, sn.length)
      if (longer === 0) return true
      // Simple similarity: common prefix length as fraction of longer string
      let common = 0
      while (common < shorter && norm[common] === sn[common]) common++
      return common / longer >= 0.8
    })
    if (!isDup) seen.push(q)
  }
  return seen
}

/**
 * Phase 1.5: Alignment chat — max 2 rounds.
 *
 * Round 1: each model sees the other's Phase 1 thinking output and responds.
 * Round 2: only triggered if a mismatch is detected in round 1. Both models
 *          try to resolve; any remaining conflict is surfaced as a required
 *          Phase 2 question so the human can decide.
 *
 * Output token budget for alignment messages: 3k tokens total (positions are
 * max 200 words each per the ALIGNMENT_SYSTEM_PROMPT).
 */
export async function runPhase1_5Alignment(
  projectId:       string,
  sessionId:       string,
  taskDescription: string,
  primaryThinking: ThinkingOutput,
  reviewerThinking:ThinkingOutput,
  primary:         ModelAdapter,
  reviewer:        ModelAdapter,
  emit:            (event: SSEEvent) => void,
  contextText?:    string,
): Promise<AlignmentResult> {
  await logPhaseStart(projectId, sessionId, 'phase1_5_alignment', 'Phase 1.5: Alignment')
  emit({ type: 'phase_change', phase: 'phase1_5_alignment' })

  const messages: AlignmentMessage[] = []
  let totalTokens = 0
  let mismatchDetected = false
  let roundsTaken: 1 | 2 = 1

  // ─── Round 1 ────────────────────────────────────────────────────────────────

  const [r1Primary, r1Reviewer] = await Promise.all([
    retryWithTimeout(
      () => primary.chat(1, taskDescription, primaryThinking, reviewerThinking, undefined, contextText),
      { timeoutMs: TIMEOUT_DEFAULT_MS, label: 'phase1_5:primary:chat:r1' },
    ),
    retryWithTimeout(
      () => reviewer.chat(1, taskDescription, reviewerThinking, primaryThinking, undefined, contextText),
      { timeoutMs: TIMEOUT_DEFAULT_MS, label: 'phase1_5:reviewer:chat:r1' },
    ),
  ])

  messages.push(r1Primary, r1Reviewer)
  totalTokens += estimateTokens(r1Primary.position + r1Reviewer.position)

  await Promise.all([
    logAlignmentMessage(projectId, sessionId, r1Primary,  primary.getProvider(), reviewer.getProvider()),
    logAlignmentMessage(projectId, sessionId, r1Reviewer, primary.getProvider(), reviewer.getProvider()),
  ])

  emit({ type: 'alignment_msg', message: r1Primary  })
  emit({ type: 'alignment_msg', message: r1Reviewer })

  mismatchDetected = detectMismatch(r1Primary, r1Reviewer)

  // ─── Round 2 (only if mismatch detected) ────────────────────────────────────

  let r2Primary: AlignmentMessage | null  = null
  let r2Reviewer: AlignmentMessage | null = null

  if (mismatchDetected && MAX_ALIGNMENT_ROUNDS >= 2) {
    roundsTaken = 2

    // Pass round 1 messages so each model can see what the other said and respond to it
    const r1Messages = [r1Primary, r1Reviewer]

    const [r2p, r2r] = await Promise.all([
      retryWithTimeout(
        () => primary.chat(2, taskDescription, primaryThinking, reviewerThinking, r1Messages, contextText),
        { timeoutMs: TIMEOUT_DEFAULT_MS, label: 'phase1_5:primary:chat:r2' },
      ),
      retryWithTimeout(
        () => reviewer.chat(2, taskDescription, reviewerThinking, primaryThinking, r1Messages, contextText),
        { timeoutMs: TIMEOUT_DEFAULT_MS, label: 'phase1_5:reviewer:chat:r2' },
      ),
    ])

    r2Primary  = r2p
    r2Reviewer = r2r
    messages.push(r2Primary, r2Reviewer)
    totalTokens += estimateTokens(r2Primary.position + r2Reviewer.position)

    await Promise.all([
      logAlignmentMessage(projectId, sessionId, r2Primary,  primary.getProvider(), reviewer.getProvider()),
      logAlignmentMessage(projectId, sessionId, r2Reviewer, primary.getProvider(), reviewer.getProvider()),
    ])

    emit({ type: 'alignment_msg', message: r2Primary  })
    emit({ type: 'alignment_msg', message: r2Reviewer })

    // After round 2 the mismatch detection is final
    mismatchDetected = detectMismatch(r2Primary, r2Reviewer)
  }

  // ─── Build shared question list ──────────────────────────────────────────────

  // Collect questions from both thinking outputs, tag source correctly
  const allQuestions = [
    ...primaryThinking.questions.map(q => ({ ...q, source: 'primary' as const })),
    ...reviewerThinking.questions.map(q => ({ ...q, source: 'reviewer' as const })),
  ]

  const agreedQuestions = deduplicateQuestions(allQuestions)

  // ─── Unresolved conflicts → required Phase 2 questions ───────────────────────

  const unresolvedConflicts: string[] = []

  if (mismatchDetected) {
    const finalPrimary  = r2Primary  ?? r1Primary
    const finalReviewer = r2Reviewer ?? r1Reviewer

    const conflict = `Primary model: "${finalPrimary.position.slice(0, 200)}" / ` +
                     `Reviewer model: "${finalReviewer.position.slice(0, 200)}"`

    unresolvedConflicts.push(conflict)

    // Convert to a required question so the human resolves it in Phase 2
    const conflictQuestion: Question = {
      id:                    generateId(),
      text:                  'The two models have different architectural opinions — which approach should we take?',
      category:              'core_behavior',
      source:                'alignment',
      options: [
        {
          id:          generateId(),
          label:       `Primary model's approach`,
          description: finalPrimary.position.slice(0, 300),
        },
        {
          id:          generateId(),
          label:       `Reviewer model's approach`,
          description: finalReviewer.position.slice(0, 300),
        },
      ],
      recommendation_reason: 'Architectural disagreement between models — human decision required.',
      is_required:           true,
    }

    agreedQuestions.unshift(conflictQuestion)

    await logAlignmentConflict(projectId, sessionId, conflict)
  }

  // ─── Agreed recommendations (positions from round 1 if no conflict) ──────────

  const agreedRecommendations: string[] = []
  if (!mismatchDetected) {
    agreedRecommendations.push(primaryThinking.recommended_approach)
  }

  return {
    messages,
    agreed_questions:               agreedQuestions,
    agreed_recommendations:         agreedRecommendations,
    unresolved_conflicts:           unresolvedConflicts,
    architectural_mismatch_detected: mismatchDetected,
    rounds_taken:                   roundsTaken,
    total_tokens:                   totalTokens,
  }
}
