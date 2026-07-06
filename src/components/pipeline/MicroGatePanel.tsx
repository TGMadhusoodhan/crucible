'use client'

import { useState } from 'react'
import { usePipeline } from '@/hooks/usePipeline'
import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'

export function MicroGatePanel() {
  const { conflicts } = usePipelineState()
  const { submitMicroGate } = usePipeline()
  const [index, setIndex]         = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  const conflict = conflicts[Math.min(index, conflicts.length - 1)]

  if (!conflict) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-zinc-600 animate-pulse">Loading conflict…</p>
      </div>
    )
  }

  async function choose(choice: 'R1' | 'R2') {
    setError(null)
    setSubmitting(true)
    try {
      await submitMicroGate(conflict!.id, choice)
      // The server removes this conflict from state.conflicts and reconnects;
      // advance locally too in case more than one conflict is queued client-side.
      setIndex(i => i + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-6 overflow-y-auto">
      <div className="w-full max-w-2xl space-y-4">
        <div className="rounded-lg border border-amber-800/50 bg-amber-950/10 p-4 space-y-1">
          <h2 className="text-sm font-medium text-amber-400">R1 and R2 disagree on this fix</h2>
          <p className="text-xs text-zinc-400">
            {conflict.filename} lines {conflict.line_start}–{conflict.line_end}
          </p>
          {conflicts.length > 1 && (
            <p className="text-[10px] text-zinc-600">
              Conflict {Math.min(index, conflicts.length - 1) + 1} of {conflicts.length}
            </p>
          )}
        </div>

        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
            Original code
          </p>
          <pre className="rounded border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400 overflow-x-auto whitespace-pre">
            {conflict.original_code}
          </pre>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">R1's fix</p>
            <pre className="rounded border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-200 overflow-x-auto whitespace-pre max-h-56">
              {conflict.r1_hunk.fixed_code}
            </pre>
            <p className="text-[10px] text-zinc-500 italic">R1's reasoning: {conflict.r1_hunk.issue}</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">R2's fix</p>
            <pre className="rounded border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-200 overflow-x-auto whitespace-pre max-h-56">
              {conflict.r2_hunk.fixed_code}
            </pre>
            <p className="text-[10px] text-zinc-500 italic">R2's reasoning: {conflict.r2_hunk.issue}</p>
          </div>
        </div>

        {error && (
          <p className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-400">{error}</p>
        )}

        <div className="flex gap-2">
          <button
            onClick={() => void choose('R1')}
            disabled={submitting}
            className={cn(
              'flex-1 rounded py-2 text-xs font-medium transition-colors',
              !submitting ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
            )}
          >
            Use R1's fix
          </button>
          <button
            onClick={() => void choose('R2')}
            disabled={submitting}
            className={cn(
              'flex-1 rounded py-2 text-xs font-medium transition-colors',
              !submitting ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
            )}
          >
            Use R2's fix
          </button>
        </div>
      </div>
    </div>
  )
}
