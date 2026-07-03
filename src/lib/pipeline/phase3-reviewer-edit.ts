import { applyHunks } from '@/lib/utils/hunks'
import { logPhaseStart } from '@/lib/memory/session-log'
import { retryWithTimeout, TIMEOUT_REVIEW_MS } from '@/lib/utils/retry'
import { dbg } from '@/lib/debug'
import type { ModelAdapter, PipelineContext, ReviewEdit, ReviewPayload, SSEEvent } from '@/types'

/**
 * Phase 3b — Reviewer produces surgical code hunks.
 *
 * After finding issues in the code review, the reviewer now directly edits
 * the flagged sections instead of returning pseudo-code hints. Each hunk
 * contains an exact original snippet and the corrected replacement.
 * applyHunks() merges them into the code without touching anything else.
 */
export async function runPhase3ReviewerEdit(
  projectId:  string,
  sessionId:  string,
  code:       string,
  review:     ReviewPayload,
  ctx:        PipelineContext,
  reviewer:   ModelAdapter,
  round:      number,
  emit:       (event: SSEEvent) => void,
): Promise<{ edit: ReviewEdit; mergedCode: string }> {
  await logPhaseStart(projectId, sessionId, 'phase3_reviewer_edit', `Phase 3: Reviewer Edit (round ${round})`)
  emit({ type: 'phase_change', phase: 'phase3_reviewer_edit' })
  dbg.edit('calling reviewer.reviewerEdit()', { reviewer: `${reviewer.getProvider()}:${reviewer.getModelId()}`, round })

  const edit = await retryWithTimeout(
    () => reviewer.reviewerEdit(code, ctx.spec, review, round),
    { timeoutMs: TIMEOUT_REVIEW_MS, label: `phase3:reviewerEdit:round${round}` },
  )
  dbg.edit('hunks received from reviewer', { hunks: edit.hunks.length, reasoning: edit.reasoning.slice(0, 100) })

  // Apply reviewer's hunks to produce merged code
  const mergedCode = edit.hunks.length > 0 ? applyHunks(code, edit.hunks) : code
  dbg.edit('hunks applied', { originalLen: code.length, mergedLen: mergedCode.length, delta: mergedCode.length - code.length })

  emit({ type: 'reviewer_edit_done', edit })

  return { edit, mergedCode }
}
