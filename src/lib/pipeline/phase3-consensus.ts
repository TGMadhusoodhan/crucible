import { writeOutput, saveCheckpoint } from '@/lib/memory/filesystem'
import { logOutputPromoted } from '@/lib/memory/session-log'
import { generateId } from '@/lib/utils'
import type { ConsensusOutput, PipelineContext, ReviewPayload, SSEEvent } from '@/types'


export interface ConsensusDecision {
  promote:           boolean
  escalate:          boolean
  escalationReason?: string
  output?:           ConsensusOutput
}

/**
 * Phase 3 — Consensus routing.
 *
 * consensus: true  → promote code to output layer, save checkpoint, done.
 * consensus: false → return { promote: false, escalate: false }.
 *                    The reviewer's flags go back to the coder as PATCH MODE instructions.
 *                    No round limit — loops until the reviewer gives consensus: true.
 */
export async function runPhase3Consensus(
  projectId: string,
  sessionId: string,
  code:      string,
  review:    ReviewPayload,
  ctx:       PipelineContext,
  emit:      (event: SSEEvent) => void,
): Promise<ConsensusDecision> {
  emit({ type: 'phase_change', phase: 'phase3_consensus' })

  // ─── Consensus reached ────────────────────────────────────────────────────────

  if (review.consensus) {
    const checkpointId = await saveCheckpoint(
      projectId,
      'module_complete',
      `Consensus reached on round ${review.round}`,
      { 'output.txt': code },
    )

    // Write consensus-validated code to the output layer
    await writeOutput(projectId, 'output.txt', code)

    await logOutputPromoted(projectId, sessionId, checkpointId)

    const output: ConsensusOutput = {
      code,
      review,
      promoted_at:   Date.now(),
      checkpoint_id: checkpointId,
    }

    emit({ type: 'consensus', output })
    emit({ type: 'done' })

    return { promote: true, escalate: false, output }
  }

  // ─── No consensus — coder must keep patching until reviewer approves ─────────
  // No round limit. The reviewer's flags go back to the coder every round.
  // Pipeline loops until consensus: true.

  emit({ type: 'conflict', review, round: review.round })

  return { promote: false, escalate: false }
}

/**
 * Called by the orchestrator after a human resolves an escalated conflict.
 * Promotes the code directly, bypassing the review check — human is the
 * final arbiter.
 */
export async function promoteAfterHumanResolution(
  projectId: string,
  sessionId: string,
  code:      string,
  review:    ReviewPayload,
  emit:      (event: SSEEvent) => void,
): Promise<ConsensusOutput> {
  const checkpointId = generateId()

  await saveCheckpoint(
    projectId,
    'human_confirm',
    'Human resolved conflict and approved code',
    { 'output.txt': code },
  )

  await writeOutput(projectId, 'output.txt', code)
  await logOutputPromoted(projectId, sessionId, checkpointId)

  const output: ConsensusOutput = {
    code,
    review,
    promoted_at:   Date.now(),
    checkpoint_id: checkpointId,
  }

  emit({ type: 'consensus', output })
  emit({ type: 'done' })

  return output
}
