'use client'

import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'
import type { ResolvedHunk } from '@/types'

function SourceBadge({ source }: { source: ResolvedHunk['source'] }) {
  const label =
    source === 'R1'    ? 'R1'    :
    source === 'R2'    ? 'R2'    :
    source === 'human' ? 'Human' :
    source === 'cross_review' ? 'Cross-review' : 'Both'
  const cls =
    source === 'R1'    ? 'bg-blue-950/60 text-blue-400'   :
    source === 'R2'    ? 'bg-purple-950/60 text-purple-400' :
    source === 'human' ? 'bg-amber-950/60 text-amber-400' :
                          'bg-indigo-950/60 text-indigo-400'
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold shrink-0', cls)}>
      {label}
    </span>
  )
}

export function PatchingPanel() {
  const { currentFilename, resolvedHunks } = usePipelineState()

  return (
    <div className="flex h-full flex-col items-center justify-center p-8">
      <div className="w-full max-w-xl space-y-4">
        <div className="text-center space-y-1">
          <div className="flex items-center justify-center gap-2">
            <span className="h-2 w-2 rounded-full bg-indigo-400 animate-pulse" />
            <h2 className="text-sm font-medium text-zinc-200">
              Applying {resolvedHunks.length} fix{resolvedHunks.length !== 1 ? 'es' : ''} to {currentFilename ?? 'file'}…
            </h2>
          </div>
          <p className="text-xs text-zinc-600">DeepSeek integrating reviewer-approved changes</p>
        </div>

        {resolvedHunks.length > 0 && (
          <div className="space-y-1.5">
            {resolvedHunks.map((hunk, i) => (
              <div
                key={`${hunk.filename}-${hunk.line_start}-${i}`}
                className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2"
              >
                <span className="text-xs text-zinc-400 truncate min-w-0 mr-2">
                  {hunk.filename} · lines {hunk.line_start}–{hunk.line_end}
                </span>
                <SourceBadge source={hunk.source} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
