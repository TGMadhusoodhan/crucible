import { logPhaseStart } from '@/lib/memory/session-log'
import { retryWithTimeout, TIMEOUT_DEFAULT_MS } from '@/lib/utils/retry'
import { dbg } from '@/lib/debug'
import type {
  CoderVerification,
  DialogueSummary,
  ModelAdapter,
  PipelineContext,
  ReviewEdit,
  ReviewPayload,
  SSEEvent,
} from '@/types'

const MAX_DIALOGUE_ROUNDS = 3

/**
 * Phase 3b — Structured back-and-forth between coder and reviewer.
 *
 * When the coder disputes the reviewer's edits, they enter a dialogue
 * (up to 3 rounds). Each round:
 *   1. Coder sends a question or concern
 *   2. Reviewer responds with { response, resolved }
 *
 * If resolved: mergedCode (reviewer's edits) is ready for consensus.
 * If not resolved after MAX_DIALOGUE_ROUNDS: escalate to human with
 * both models' final positions displayed in the ConflictPanel.
 */
export async function runPhase3Dialogue(
  projectId:    string,
  sessionId:    string,
  code:         string,
  mergedCode:   string,
  edit:         ReviewEdit,
  verification: CoderVerification,
  review:       ReviewPayload,
  ctx:          PipelineContext,
  primary:      ModelAdapter,
  reviewer:     ModelAdapter,
  round:        number,
  emit:         (event: SSEEvent) => void,
): Promise<DialogueSummary> {
  await logPhaseStart(projectId, sessionId, 'phase3_dialogue', `Phase 3: Model Dialogue (round ${round})`)
  emit({ type: 'phase_change', phase: 'phase3_dialogue' })
  dbg.dialogue('starting dialogue', {
    coder:    `${primary.getProvider()}:${primary.getModelId()}`,
    reviewer: `${reviewer.getProvider()}:${reviewer.getModelId()}`,
    maxRounds:MAX_DIALOGUE_ROUNDS,
  })

  const summary: DialogueSummary = {
    messages:              [],
    rounds:                0,
    resolved:              false,
    coderFinalPosition:    verification.concerns.join('. ') || verification.first_question || '',
    reviewerFinalPosition: review.reasoning,
  }

  let currentVerification = verification

  for (let dialogueRound = 1; dialogueRound <= MAX_DIALOGUE_ROUNDS; dialogueRound++) {
    summary.rounds = dialogueRound
    dbg.dialogue(`round ${dialogueRound}/${MAX_DIALOGUE_ROUNDS} — coder turn`)

    // Coder's turn
    const coderMessage = await retryWithTimeout(
      () => primary.coderDialogue(code, summary, currentVerification),
      { timeoutMs: TIMEOUT_DEFAULT_MS, label: `dialogue:coder:${dialogueRound}` },
    )
    const coderMsg = { actor: 'coder' as const, content: coderMessage, round: dialogueRound }
    summary.messages.push(coderMsg)
    summary.coderFinalPosition = coderMessage
    emit({ type: 'dialogue_msg', message: coderMsg })
    dbg.dialogue(`coder said`, { round: dialogueRound, msg: coderMessage.slice(0, 120) })

    // Reviewer's turn
    dbg.dialogue(`round ${dialogueRound} — reviewer turn`)
    const reviewerReply = await retryWithTimeout(
      () => reviewer.reviewerDialogue(code, summary, review),
      { timeoutMs: TIMEOUT_DEFAULT_MS, label: `dialogue:reviewer:${dialogueRound}` },
    )
    const reviewerMsg = {
      actor: 'reviewer' as const,
      content: reviewerReply.response,
      round: dialogueRound,
      resolved: reviewerReply.resolved,
    }
    summary.messages.push(reviewerMsg)
    summary.reviewerFinalPosition = reviewerReply.response
    emit({ type: 'dialogue_msg', message: reviewerMsg })
    dbg.dialogue(`reviewer said`, { round: dialogueRound, resolved: reviewerReply.resolved, msg: reviewerReply.response.slice(0, 120) })

    // Check if coder's message signals resolution
    const coderResolved = coderMessage.toUpperCase().includes('RESOLVED')
    if (reviewerReply.resolved || coderResolved) {
      dbg.dialogue('RESOLVED', { round: dialogueRound, resolvedBy: reviewerReply.resolved ? 'reviewer' : 'coder' })
      summary.resolved = true
      emit({ type: 'dialogue_resolved', mergedCode })
      break
    }

    // Synthesise a new verification representing the coder's current state after dialogue
    currentVerification = {
      agrees:         false,
      accepted_hunks: currentVerification.accepted_hunks,
      rejected_hunks: currentVerification.rejected_hunks,
      concerns:       [coderMessage],
      first_question: undefined,
    }
  }

  if (!summary.resolved) {
    dbg.dialogue('ESCALATED — max rounds reached without resolution', { rounds: summary.rounds })
    emit({ type: 'dialogue_escalated', summary })
  }

  return summary
}
