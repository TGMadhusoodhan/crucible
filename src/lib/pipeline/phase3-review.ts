import { appendSessionLog } from '@/lib/memory/session-log'
import type { FileManifest, ModelAdapter, ReviewHunk, SpecDocument, SSEEvent } from '@/types'

export async function runPhase3Review(
  projectId:      string,
  sessionId:      string,
  filename:       string,
  code:           string,
  spec:           SpecDocument,
  manifest:       FileManifest,
  round:          number,
  r1Adapter:      ModelAdapter,
  r2Adapter:      ModelAdapter,
  emit:           (e: SSEEvent) => void,
  previousHunks?: ReviewHunk[],
): Promise<{ r1: ReviewHunk[]; r2: ReviewHunk[] }> {
  emit({ type: 'phase_change', phase: 'phase3_reviewing' })

  const [r1Hunks, r2Hunks] = await Promise.all([
    r1Adapter.reviewAndPatch(filename, code, spec, manifest, round, previousHunks),
    r2Adapter.reviewAndPatch(filename, code, spec, manifest, round, previousHunks),
  ])

  emit({ type: 'review_hunks', actor: 'r1', hunks: r1Hunks })
  emit({ type: 'review_hunks', actor: 'r2', hunks: r2Hunks })

  await appendSessionLog(projectId, sessionId, {
    phase: 'phase3_reviewing', actor: 'system', round,
    summary: `R1: ${r1Hunks.filter(h => h.severity === 'HIGH').length} HIGH | `
           + `R2: ${r2Hunks.filter(h => h.severity === 'HIGH').length} HIGH`,
  })

  return { r1: r1Hunks, r2: r2Hunks }
}
