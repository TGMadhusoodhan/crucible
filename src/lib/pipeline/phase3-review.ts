import { appendSessionLog } from '@/lib/memory/session-log'
import type { BudgetMode, FileManifest, ModelAdapter, PreviousHunkRecord, ReviewHunk, SpecDocument, SSEEvent } from '@/types'

export async function runPhase3Review(
  projectId:             string,
  sessionId:             string,
  filename:              string,
  code:                  string,
  spec:                  SpecDocument,
  manifest:              FileManifest,
  round:                 number,
  r1Adapter:             ModelAdapter,
  r2Adapter:             ModelAdapter,
  emit:                  (e: SSEEvent) => void,
  previousHunkRecords?:  PreviousHunkRecord[],
  compilerErrors?:       string[],
  budgetMode?:           BudgetMode,
): Promise<{ r1: ReviewHunk[]; r2: ReviewHunk[] }> {
  emit({ type: 'phase_change', phase: 'phase3_reviewing' })

  const highSeverityOnly = budgetMode === 'EFFICIENT'
  const reviewOptions = highSeverityOnly ? { highSeverityOnly: true } : undefined

  let r1Hunks: ReviewHunk[]
  let r2Hunks: ReviewHunk[]
  let totalDropped: number

  if (budgetMode === 'CONSERVATION') {
    // Single-reviewer mode: only R1 reviews, R2 is idle.
    const r1Result = await r1Adapter.reviewAndPatch(
      filename, code, spec, manifest, round, previousHunkRecords, compilerErrors,
    )
    r1Hunks = r1Result.hunks
    r2Hunks = []
    totalDropped = r1Result.droppedCount

    emit({ type: 'review_hunks', actor: 'r1', hunks: r1Hunks })
    if (round === 1) {
      emit({
        type: 'budget_degradation',
        reason: 'CONSERVATION mode: R2 reviewer skipped to reduce cost',
        skipped: ['r2_review', 'cross_review'],
      })
    }
  } else {
    const [r1Result, r2Result] = await Promise.all([
      r1Adapter.reviewAndPatch(filename, code, spec, manifest, round, previousHunkRecords, compilerErrors, reviewOptions),
      r2Adapter.reviewAndPatch(filename, code, spec, manifest, round, previousHunkRecords, compilerErrors, reviewOptions),
    ])

    r1Hunks = r1Result.hunks
    r2Hunks = r2Result.hunks
    totalDropped = r1Result.droppedCount + r2Result.droppedCount

    emit({ type: 'review_hunks', actor: 'r1', hunks: r1Hunks })
    emit({ type: 'review_hunks', actor: 'r2', hunks: r2Hunks })
  }

  if (totalDropped > 0) {
    emit({ type: 'hunks_dropped', filename, count: totalDropped, reasons: [] })
  }

  const budgetLabel = budgetMode && budgetMode !== 'FULL' ? ` [budget:${budgetMode}]` : ''
  await appendSessionLog(projectId, sessionId, {
    phase: 'phase3_reviewing', actor: 'system', round,
    summary: `R1: ${r1Hunks.filter(h => h.severity === 'HIGH').length} HIGH | `
           + `R2: ${r2Hunks.filter(h => h.severity === 'HIGH').length} HIGH`
           + (totalDropped > 0 ? ` | ${totalDropped} dropped (bad anchor)` : '')
           + budgetLabel,
  })

  return { r1: r1Hunks, r2: r2Hunks }
}
