import { appendReviewList } from '@/lib/memory/filesystem'
import { logPhaseStart, logReview } from '@/lib/memory/session-log'
import { retryWithTimeout, TIMEOUT_REVIEW_MS } from '@/lib/utils/retry'
import { estimateTokens } from '@/lib/utils/tokens'
import { dbg } from '@/lib/debug'
import type { ModelAdapter, PipelineContext, ReviewPayload, SSEEvent } from '@/types'

/**
 * Phase 3 — Cross-model code review.
 *
 * The reviewer model reviews the primary's code and returns a structured
 * ReviewPayload. Flag routing:
 *   HIGH/MEDIUM → included in payload, sent back to primary for patching
 *   LOW         → sent to review_list.json (informational, not blocking)
 *
 * The reviewer never sees the primary's self-check output — it reviews
 * the code cold, using only the spec as the source of truth.
 */
export async function runPhase3Review(
  projectId:      string,
  sessionId:      string,
  code:           string,
  ctx:            PipelineContext,
  reviewer:       ModelAdapter,
  round:          number,
  emit:           (event: SSEEvent) => void,
  previousReview?: ReviewPayload,
): Promise<ReviewPayload> {
  await logPhaseStart(projectId, sessionId, 'phase3_reviewing', `Phase 3: Review (round ${round})`)
  emit({ type: 'phase_change', phase: 'phase3_reviewing' })
  dbg.review(`calling reviewer.review()`, {
    reviewer: `${reviewer.getProvider()}:${reviewer.getModelId()}`,
    round,
    codeLen:  code.length,
  })

  const review = await retryWithTimeout(
    () => reviewer.review(code, ctx.spec, round, previousReview),
    { timeoutMs: TIMEOUT_REVIEW_MS, label: `phase3:review:round${round}` },
  )
  dbg.review('review received', {
    round,
    consensus: review.consensus,
    flags:     review.flags.length,
    high:      review.flags.filter(f => f.severity === 'HIGH').length,
    medium:    review.flags.filter(f => f.severity === 'MEDIUM').length,
    low:       review.flags.filter(f => f.severity === 'LOW').length,
    reasoning: review.reasoning.slice(0, 120),
  })

  // ─── Route LOW flags to review_list (informational archive) ──────────────────

  const lowFlags = review.flags.filter(f => f.severity === 'LOW')
  if (lowFlags.length > 0) {
    await Promise.all(lowFlags.map(flag => appendReviewList(projectId, flag)))
  }

  // ─── Log and emit ─────────────────────────────────────────────────────────────

  const costUsd = reviewer.estimateCost(
    estimateTokens(code) + estimateTokens(JSON.stringify(ctx.spec)),
    estimateTokens(JSON.stringify(review)),
  )

  await logReview(projectId, sessionId, review, costUsd, reviewer.getProvider())
  emit({ type: 'review_done', review })

  return review
}
