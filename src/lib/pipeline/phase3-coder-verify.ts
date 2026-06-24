import { logPhaseStart } from '@/lib/memory/session-log'
import { retryWithTimeout, TIMEOUT_DEFAULT_MS } from '@/lib/utils/retry'
import type { CoderVerification, ModelAdapter, PipelineContext, ReviewEdit, ReviewPayload, SSEEvent } from '@/types'

/**
 * Phase 3b — Coder explicitly evaluates the reviewer's hunks.
 *
 * The coder sees its original code, the reviewer's hunks, and the merged
 * result. It returns a structured verdict: agrees (all hunks accepted) or
 * disagrees (with specific concerns and a question to start dialogue).
 */
export async function runPhase3CoderVerify(
  projectId:    string,
  sessionId:    string,
  originalCode: string,
  edit:         ReviewEdit,
  mergedCode:   string,
  review:       ReviewPayload,
  ctx:          PipelineContext,
  primary:      ModelAdapter,
  round:        number,
  emit:         (event: SSEEvent) => void,
): Promise<CoderVerification> {
  await logPhaseStart(projectId, sessionId, 'phase3_coder_verify', `Phase 3: Coder Verify (round ${round})`)
  emit({ type: 'phase_change', phase: 'phase3_coder_verify' })

  // If reviewer produced no hunks (no actionable edits), coder auto-agrees
  if (edit.hunks.length === 0) {
    const verification: CoderVerification = {
      agrees:         true,
      accepted_hunks: [],
      rejected_hunks: [],
      concerns:       [],
    }
    emit({ type: 'coder_verify_done', verification })
    return verification
  }

  const verification = await retryWithTimeout(
    () => primary.coderVerify(originalCode, edit, mergedCode, review),
    { timeoutMs: TIMEOUT_DEFAULT_MS, label: `phase3:coderVerify:round${round}` },
  )

  emit({ type: 'coder_verify_done', verification })
  return verification
}
