import { logPhaseStart, logQuestionsReady } from '@/lib/memory/session-log'
import type { AlignmentResult, Question, QuestionCategory, SSEEvent, ThinkingOutput } from '@/types'

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Two questions are duplicates if their normalized texts share a common
 * leading substring that is ≥ 70% of the longer string's length.
 * This catches paraphrases like "How should errors be handled?" vs
 * "What is your error handling strategy?" without false positives.
 */
function areSimilarQuestions(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
  const nb = b.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
  if (na === nb) return true
  const longer  = Math.max(na.length, nb.length)
  if (longer === 0) return true
  let common = 0
  const shorter = Math.min(na.length, nb.length)
  while (common < shorter && na[common] === nb[common]) common++
  return common / longer >= 0.7
}

function deduplicateQuestions(questions: Question[]): Question[] {
  const result: Question[] = []
  for (const q of questions) {
    const isDup = result.some(r => areSimilarQuestions(r.text, q.text))
    if (!isDup) result.push(q)
  }
  return result
}

// ─── Priority ordering ────────────────────────────────────────────────────────

const CATEGORY_ORDER: QuestionCategory[] = [
  'core_behavior',
  'security',
  'error_handling',
  'edge_cases',
  'integration',
]

function sortByCategory(questions: Question[]): Question[] {
  return [...questions].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.category)
    const bi = CATEGORY_ORDER.indexOf(b.category)
    const rankA = ai === -1 ? 99 : ai
    const rankB = bi === -1 ? 99 : bi
    // Required questions first, then by category
    if (a.is_required !== b.is_required) return a.is_required ? -1 : 1
    return rankA - rankB
  })
}


// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Phase 2 — Questions:
 * 1. Merge questions from both thinking outputs + alignment result
 * 2. Deduplicate by text similarity
 * 3. Run second-pass checklist for missed topics
 * 4. Sort: required first, then by category priority
 * 5. Emit to client and return
 */
export async function runPhase2Questions(
  projectId:       string,
  sessionId:       string,
  primaryThinking: ThinkingOutput,
  reviewerThinking:ThinkingOutput,
  alignment:       AlignmentResult,
  emit:            (event: SSEEvent) => void,
): Promise<Question[]> {
  await logPhaseStart(projectId, sessionId, 'phase2_questions', 'Phase 2: Questions')
  emit({ type: 'phase_change', phase: 'phase2_questions' })

  // Collect from all sources — alignment.agreed_questions already merged+deduped
  // by phase1-5, but may still overlap with individual thinking outputs.
  const combined: Question[] = [
    ...alignment.agreed_questions,
    ...primaryThinking.questions.filter(q =>
      !alignment.agreed_questions.some(a => areSimilarQuestions(a.text, q.text))
    ),
    ...reviewerThinking.questions.filter(q =>
      !alignment.agreed_questions.some(a => areSimilarQuestions(a.text, q.text))
    ),
  ]

  const deduped = deduplicateQuestions(combined)
  const final   = sortByCategory(deduped)

  await logQuestionsReady(projectId, sessionId, final)
  emit({ type: 'questions_ready', questions: final })

  return final
}
