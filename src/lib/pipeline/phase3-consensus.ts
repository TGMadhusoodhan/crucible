import { saveCheckpoint } from '@/lib/memory/filesystem'
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
 * consensus: true  → save checkpoint, emit file_ready for first file, pause at file gate.
 *                    Files are NOT written to disk here — that happens in file-accept route
 *                    after the user reviews and approves each file.
 * consensus: false → return { promote: false, escalate: false }.
 *                    The reviewer's flags go back to the coder as PATCH MODE instructions.
 *                    No round limit — loops until the reviewer gives consensus: true.
 */
export async function runPhase3Consensus(
  projectId: string,
  sessionId: string,
  code:      string,
  files:     Record<string, string>,
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
      files,
    )

    await logOutputPromoted(projectId, sessionId, checkpointId)

    const output: ConsensusOutput = {
      code,
      files,
      review,
      promoted_at:   Date.now(),
      checkpoint_id: checkpointId,
    }

    // Emit consensus (client stores output + files in state)
    emit({ type: 'consensus', output })

    // Transition to file gate — emit phase_change BEFORE file_ready so
    // lastPhaseRef on the client is set to 'phase3_file_gate' (which is in
    // NO_AUTO_RECONNECT) before the stream closes. Without this the client
    // would see lastPhaseRef='phase3_consensus' and auto-reconnect in a loop.
    emit({ type: 'phase_change', phase: 'phase3_file_gate' })

    const filenames = Object.keys(files)
    if (filenames.length > 0) {
      emit({ type: 'file_ready', filename: filenames[0]!, code: files[filenames[0]!]!, fileIndex: 0, totalFiles: filenames.length })
    }

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
  files:     Record<string, string>,
  review:    ReviewPayload,
  emit:      (event: SSEEvent) => void,
): Promise<ConsensusOutput> {
  const checkpointId = generateId()

  await saveCheckpoint(
    projectId,
    'human_confirm',
    'Human resolved conflict and approved code',
    files,
  )

  await logOutputPromoted(projectId, sessionId, checkpointId)

  const output: ConsensusOutput = {
    code,
    files,
    review,
    promoted_at:   Date.now(),
    checkpoint_id: checkpointId,
  }

  emit({ type: 'consensus', output })

  const filenames = Object.keys(files)
  if (filenames.length > 0) {
    emit({ type: 'file_ready', filename: filenames[0]!, code: files[filenames[0]!]!, fileIndex: 0, totalFiles: filenames.length })
  }

  emit({ type: 'done' })

  return output
}
