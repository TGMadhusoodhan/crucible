'use client'

import { useState } from 'react'
import { usePipeline } from '@/hooks/usePipeline'
import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'

export function ArbitrationPanel() {
  const { arbitrationPkg } = usePipelineState()
  const { submitArbitration } = usePipeline()
  const [guidance, setGuidance]     = useState('')
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [error, setError]           = useState<string | null>(null)

  if (!arbitrationPkg) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-zinc-600 animate-pulse">Loading arbitration…</p>
      </div>
    )
  }

  const { filename, round, unresolved_hunks, r1_summary, r2_summary } = arbitrationPkg
  const r1Hunks = unresolved_hunks.filter(h => h.source === 'R1')
  const r2Hunks = unresolved_hunks.filter(h => h.source === 'R2')

  async function choose(choice: 'r1' | 'r2' | 'accept' | 'regenerate') {
    setError(null)
    setSubmitting(choice)
    try {
      await submitArbitration(filename, choice, guidance.trim() || undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit')
      setSubmitting(null)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-8">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <div className="space-y-1.5">
          <h2 className="text-base font-semibold text-red-400">
            Round {round} exhausted — {filename}
          </h2>
          <p className="text-xs text-zinc-500 leading-relaxed">
            R1 and R2 still disagree on {unresolved_hunks.length} HIGH-severity issue{unresolved_hunks.length !== 1 ? 's' : ''}
            {' '}after {round} rounds of review and patching. Choose how to resolve this file.
          </p>
          <p className="text-[10px] text-zinc-600">{r1_summary} · {r2_summary}</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
              R1's fixes ({r1Hunks.length})
            </p>
            {r1Hunks.map(h => (
              <div key={h.id} className="rounded border border-zinc-800 bg-zinc-900/40 p-2.5 space-y-1">
                <p className="text-[10px] text-zinc-500">Lines {h.line_start}–{h.line_end}</p>
                <p className="text-xs text-zinc-300">{h.issue}</p>
                <pre className="rounded bg-zinc-950 p-2 text-[10px] text-zinc-300 overflow-x-auto whitespace-pre max-h-32">
                  {h.fixed_code}
                </pre>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
              R2's fixes ({r2Hunks.length})
            </p>
            {r2Hunks.map(h => (
              <div key={h.id} className="rounded border border-zinc-800 bg-zinc-900/40 p-2.5 space-y-1">
                <p className="text-[10px] text-zinc-500">Lines {h.line_start}–{h.line_end}</p>
                <p className="text-xs text-zinc-300">{h.issue}</p>
                <pre className="rounded bg-zinc-950 p-2 text-[10px] text-zinc-300 overflow-x-auto whitespace-pre max-h-32">
                  {h.fixed_code}
                </pre>
              </div>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-[10px] font-medium text-zinc-500 uppercase tracking-wide">
            Guidance (optional — used if you regenerate)
          </label>
          <textarea
            value={guidance}
            onChange={e => setGuidance(e.target.value)}
            rows={3}
            placeholder="Tell the models what to do differently…"
            className="w-full resize-none rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
          />
        </div>

        {error && (
          <p className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-400">{error}</p>
        )}

        <div className="grid grid-cols-2 gap-2">
          <ActionButton onClick={() => void choose('r1')} loading={submitting === 'r1'} disabled={!!submitting}>
            Apply R1's fixes
          </ActionButton>
          <ActionButton onClick={() => void choose('r2')} loading={submitting === 'r2'} disabled={!!submitting}>
            Apply R2's fixes
          </ActionButton>
          <ActionButton onClick={() => void choose('accept')} loading={submitting === 'accept'} disabled={!!submitting}>
            Accept file as-is
          </ActionButton>
          <ActionButton onClick={() => void choose('regenerate')} loading={submitting === 'regenerate'} disabled={!!submitting}>
            Regenerate with guidance
          </ActionButton>
        </div>
      </div>
    </div>
  )
}

function ActionButton({
  onClick, loading, disabled, children,
}: {
  onClick: () => void
  loading: boolean
  disabled: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded border px-4 py-2.5 text-xs font-medium transition-colors',
        disabled
          ? 'border-zinc-800 bg-zinc-900 text-zinc-600 cursor-not-allowed'
          : 'border-zinc-700 text-zinc-200 hover:border-indigo-600 hover:bg-indigo-950/20',
      )}
    >
      {loading ? '…' : children}
    </button>
  )
}
