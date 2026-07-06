'use client'

import { useState } from 'react'
import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'
import type { ReviewHunk } from '@/types'

function SeverityBadge({ severity, count }: { severity: 'HIGH' | 'MEDIUM' | 'LOW'; count: number }) {
  if (count === 0) return null
  const cls =
    severity === 'HIGH'   ? 'bg-red-950/60 text-red-400'    :
    severity === 'MEDIUM' ? 'bg-amber-950/60 text-amber-400' :
                             'bg-blue-950/60 text-blue-400'
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', cls)}>
      {count} {severity}
    </span>
  )
}

function HunkCard({ hunk, expanded, onToggle }: { hunk: ReviewHunk; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="rounded border border-red-900/40 bg-red-950/10 p-2.5 space-y-1.5">
      <p className="text-[10px] text-zinc-500">Lines {hunk.line_start}–{hunk.line_end}</p>
      <p className="text-xs text-zinc-200 leading-relaxed">{hunk.issue}</p>
      <button
        onClick={onToggle}
        className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
      >
        {expanded ? 'Hide fix ▴' : 'Show fix ▾'}
      </button>
      {expanded && (
        <pre className="rounded bg-zinc-950 p-2 text-[10px] text-zinc-300 overflow-x-auto whitespace-pre">
          {hunk.fixed_code}
        </pre>
      )}
    </div>
  )
}

function ReviewerColumn({ label, hunks }: { label: string; hunks: ReviewHunk[] }) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const arrived = hunks.length > 0
  const high    = hunks.filter(h => h.severity === 'HIGH')
  const medium  = hunks.filter(h => h.severity === 'MEDIUM')
  const low     = hunks.filter(h => h.severity === 'LOW')

  function toggle(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <div className="flex-1 min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden flex flex-col">
      <div className="border-b border-zinc-800 px-3 py-2">
        <span className="text-xs font-semibold text-zinc-300">{label}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {!arrived ? (
          <div className="flex items-center gap-2 text-xs text-zinc-600">
            <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
            Reviewing…
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <SeverityBadge severity="HIGH"   count={high.length} />
              <SeverityBadge severity="MEDIUM" count={medium.length} />
              <SeverityBadge severity="LOW"    count={low.length} />
              {hunks.length === 0 && (
                <span className="text-[10px] text-emerald-500">✓ clean</span>
              )}
            </div>
            {high.map(h => (
              <HunkCard
                key={h.id}
                hunk={h}
                expanded={expandedIds.has(h.id)}
                onToggle={() => toggle(h.id)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

export function ReviewingPanel() {
  const { currentFilename, round, r1Hunks, r2Hunks, conflicts, resolvedHunks } = usePipelineState()

  const anyArrived = r1Hunks.length > 0 || r2Hunks.length > 0
  const anyHigh     = [...r1Hunks, ...r2Hunks].some(h => h.severity === 'HIGH')
  const hasConflicts = conflicts.length > 0

  return (
    <div className="flex h-full flex-col p-6 space-y-4">
      <div className="space-y-0.5 shrink-0">
        <h2 className="text-sm font-medium text-zinc-300">
          Cross-examining {currentFilename ?? 'file'} — Round {round}
        </h2>
        <p className="text-xs text-zinc-600">
          R1 and R2 independently review the generated code and produce drop-in fixes.
        </p>
      </div>

      <div className="flex-1 min-h-0 flex gap-4">
        <ReviewerColumn label="Reviewer 1" hunks={r1Hunks} />
        <ReviewerColumn label="Reviewer 2" hunks={r2Hunks} />
      </div>

      {anyArrived && (
        <div className={cn(
          'shrink-0 rounded border px-3 py-2 text-xs',
          !anyHigh
            ? 'border-emerald-900/40 bg-emerald-950/20 text-emerald-400'
            : hasConflicts
            ? 'border-amber-900/40 bg-amber-950/20 text-amber-400'
            : 'border-indigo-900/40 bg-indigo-950/20 text-indigo-400',
        )}>
          {!anyHigh
            ? '✓ File looks clean'
            : hasConflicts
            ? `⚠ ${conflicts.length} conflicting fix${conflicts.length !== 1 ? 'es' : ''} — resolving…`
            : `Applying ${resolvedHunks.length} fix${resolvedHunks.length !== 1 ? 'es' : ''}…`}
        </div>
      )}
    </div>
  )
}
