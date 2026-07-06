import type { CrossReviewResponse, HunkConflict, ModelAdapter, ResolvedHunk, ReviewHunk, SSEEvent } from '@/types'

export async function runPhase3CrossReview(
  projectId:   string,
  sessionId:   string,
  conflicts:   HunkConflict[],
  r1Adapter:   ModelAdapter,
  r2Adapter:   ModelAdapter,
  emit:        (e: SSEEvent) => void,
): Promise<{ resolved: ResolvedHunk[]; stillConflicting: HunkConflict[] }> {
  emit({ type: 'phase_change', phase: 'phase3_cross_review' })

  const resolved:        ResolvedHunk[]  = []
  const stillConflicting: HunkConflict[] = []

  // Process each conflict — cross-review in parallel per conflict
  for (const conflict of conflicts) {
    const [r1Response, r2Response] = await Promise.all([
      r1Adapter.crossReview(conflict, conflict.r1_hunk, conflict.r2_hunk),
      r2Adapter.crossReview(conflict, conflict.r2_hunk, conflict.r1_hunk),
    ])

    emit({ type: 'cross_review_response', actor: 'r1', response: r1Response })
    emit({ type: 'cross_review_response', actor: 'r2', response: r2Response })

    const winner = resolveConflictDecision(r1Response, r2Response, conflict)

    if (winner === 'micro_gate') {
      const settled = await tryResolveViaRetry(conflict, r1Response, r2Response, r1Adapter, r2Adapter)
      if (settled) {
        resolved.push(settled)
        continue
      }
      // Still disagreeing — emit micro_gate for human
      emit({ type: 'micro_gate', conflict })
      stillConflicting.push(conflict)
    } else {
      resolved.push(winner)
    }
  }

  return { resolved, stillConflicting }
}

function resolveConflictDecision(
  r1Response: CrossReviewResponse,
  r2Response: CrossReviewResponse,
  conflict:   HunkConflict,
): ResolvedHunk | 'micro_gate' {
  const r1Decision = r1Response.decision
  const r2Decision = r2Response.decision

  // Both accept the other's fix (unusual but clean)
  if (r1Decision === 'ACCEPT_THEIRS' && r2Decision === 'ACCEPT_THEIRS') {
    return toResolved(conflict.r2_hunk, 'cross_review', conflict)
  }
  // R1 accepts R2's fix
  if (r1Decision === 'ACCEPT_THEIRS' && r2Decision !== 'ACCEPT_THEIRS') {
    return toResolved(conflict.r2_hunk, 'cross_review', conflict)
  }
  // R2 accepts R1's fix
  if (r2Decision === 'ACCEPT_THEIRS' && r1Decision !== 'ACCEPT_THEIRS') {
    return toResolved(conflict.r1_hunk, 'cross_review', conflict)
  }
  // Both insist or propose new — needs more work / micro_gate
  return 'micro_gate'
}

// One retry per side: if a reviewer proposed NEW_FIX, ask the other side to
// reconsider given that fix. If THAT retry itself counters with its own
// NEW_FIX, give the first side one chance to accept the counter rather than
// silently discarding an API response we already paid for.
async function tryResolveViaRetry(
  conflict:   HunkConflict,
  r1Response: CrossReviewResponse,
  r2Response: CrossReviewResponse,
  r1Adapter:  ModelAdapter,
  r2Adapter:  ModelAdapter,
): Promise<ResolvedHunk | null> {
  if (r1Response.decision === 'NEW_FIX' && r1Response.new_code) {
    const updatedConflict: HunkConflict = {
      ...conflict,
      r1_hunk: { ...conflict.r1_hunk, fixed_code: r1Response.new_code },
    }
    const r2Retry = await r2Adapter.crossReview(updatedConflict, conflict.r2_hunk, updatedConflict.r1_hunk)
    if (r2Retry.decision === 'ACCEPT_THEIRS') {
      return toResolved(updatedConflict.r1_hunk, 'cross_review', conflict)
    }
    if (r2Retry.decision === 'NEW_FIX' && r2Retry.new_code) {
      const counterConflict: HunkConflict = {
        ...updatedConflict,
        r2_hunk: { ...updatedConflict.r2_hunk, fixed_code: r2Retry.new_code },
      }
      const r1Counter = await r1Adapter.crossReview(counterConflict, counterConflict.r1_hunk, counterConflict.r2_hunk)
      if (r1Counter.decision === 'ACCEPT_THEIRS') {
        return toResolved(counterConflict.r2_hunk, 'cross_review', conflict)
      }
    }
  }

  if (r2Response.decision === 'NEW_FIX' && r2Response.new_code) {
    const updatedConflict: HunkConflict = {
      ...conflict,
      r2_hunk: { ...conflict.r2_hunk, fixed_code: r2Response.new_code },
    }
    const r1Retry = await r1Adapter.crossReview(updatedConflict, conflict.r1_hunk, updatedConflict.r2_hunk)
    if (r1Retry.decision === 'ACCEPT_THEIRS') {
      return toResolved(updatedConflict.r2_hunk, 'cross_review', conflict)
    }
    if (r1Retry.decision === 'NEW_FIX' && r1Retry.new_code) {
      const counterConflict: HunkConflict = {
        ...updatedConflict,
        r1_hunk: { ...updatedConflict.r1_hunk, fixed_code: r1Retry.new_code },
      }
      const r2Counter = await r2Adapter.crossReview(counterConflict, counterConflict.r2_hunk, counterConflict.r1_hunk)
      if (r2Counter.decision === 'ACCEPT_THEIRS') {
        return toResolved(counterConflict.r1_hunk, 'cross_review', conflict)
      }
    }
  }

  return null
}

function toResolved(
  hunk:     ReviewHunk,
  source:   ResolvedHunk['source'],
  conflict: HunkConflict,
): ResolvedHunk {
  return {
    filename:      conflict.filename,
    line_start:    conflict.line_start,
    line_end:      conflict.line_end,
    original_code: conflict.original_code,
    new_code:      hunk.fixed_code,
    source,
    flag_ids:      [conflict.r1_hunk.id, conflict.r2_hunk.id],
  }
}
