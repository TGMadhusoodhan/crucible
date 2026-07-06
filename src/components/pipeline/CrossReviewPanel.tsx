'use client'

import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'
import type { CrossReviewResponse, HunkConflict } from '@/types'

type ConflictStatus = 'pending' | 'resolved' | 'needs_human'

function statusFor(
  r1: CrossReviewResponse | undefined,
  r2: CrossReviewResponse | undefined,
): ConflictStatus {
  if (!r1 || !r2) return 'pending'
  if (r1.decision === 'ACCEPT_THEIRS' || r2.decision === 'ACCEPT_THEIRS') return 'resolved'
  return 'needs_human'
}

function StatusBadge({ status }: { status: ConflictStatus }) {
  const cls =
    status === 'resolved'    ? 'bg-emerald-950/60 text-emerald-400' :
    status === 'needs_human' ? 'bg-amber-950/60 text-amber-400'     :
                                'bg-indigo-950/60 text-indigo-400'
  const label =
    status === 'resolved'    ? '✓ resolved'  :
    status === 'needs_human' ? '⚠ needs human' :
                                '○ pending'
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', cls)}>
      {label}
    </span>
  )
}

function ConflictCard({
  conflict, r1Response, r2Response,
}: {
  conflict:   HunkConflict
  r1Response?: CrossReviewResponse
  r2Response?: CrossReviewResponse
}) {
  const status = statusFor(r1Response, r2Response)

  return (
    <div className={cn(
      'rounded-lg border p-4 space-y-3 transition-opacity',
      status === 'resolved' ? 'border-zinc-800 bg-zinc-900/20 opacity-60' : 'border-zinc-800 bg-zinc-900/40',
    )}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-zinc-300">
          {conflict.filename} lines {conflict.line_start}–{conflict.line_end}
        </p>
        <StatusBadge status={status} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <p className="text-[10px] text-zinc-600">
            {r1Response ? 'R1\'s fix' : 'R1 reviewing R2\'s…'}
          </p>
          <pre className="rounded bg-zinc-950 p-2 text-[10px] text-zinc-300 overflow-x-auto whitespace-pre max-h-40">
            {conflict.r1_hunk.fixed_code}
          </pre>
          {r1Response && (
            <p className="text-[10px] text-zinc-500 italic">{r1Response.reason}</p>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-[10px] text-zinc-600">
            {r2Response ? 'R2\'s fix' : 'R2 reviewing R1\'s…'}
          </p>
          <pre className="rounded bg-zinc-950 p-2 text-[10px] text-zinc-300 overflow-x-auto whitespace-pre max-h-40">
            {conflict.r2_hunk.fixed_code}
          </pre>
          {r2Response && (
            <p className="text-[10px] text-zinc-500 italic">{r2Response.reason}</p>
          )}
        </div>
      </div>
    </div>
  )
}

export function CrossReviewPanel() {
  const { conflicts, crossReviewResponses } = usePipelineState()

  return (
    <div className="flex h-full flex-col p-6 space-y-4">
      <div className="space-y-0.5 shrink-0">
        <h2 className="text-sm font-medium text-zinc-300">Cross-review</h2>
        <p className="text-xs text-zinc-600">
          R1 and R2 evaluate each other's conflicting fixes for the same lines.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3">
        {conflicts.length === 0 && (
          <p className="text-xs text-zinc-600 italic text-center pt-4">No conflicts to resolve.</p>
        )}
        {conflicts.map(conflict => (
          <ConflictCard
            key={conflict.id}
            conflict={conflict}
            r1Response={crossReviewResponses[conflict.id]?.r1}
            r2Response={crossReviewResponses[conflict.id]?.r2}
          />
        ))}
      </div>
    </div>
  )
}
