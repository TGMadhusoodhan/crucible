'use client'

import { useState } from 'react'
import { usePipeline } from '@/hooks/usePipeline'
import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'

export function ConflictPanel() {
  const { lastReview, conflictReason, round } = usePipelineState()
  const { resolveConflict } = usePipeline()
  const [override, setOverride]   = useState('')
  const [resolving, setResolving] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  async function handleResolve(e: React.FormEvent) {
    e.preventDefault()
    const msg = override.trim()
    if (!msg) return
    setError(null)
    setResolving(true)
    try {
      await resolveConflict(msg)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resolution failed')
    } finally {
      setResolving(false)
    }
  }

  const highFlags = lastReview?.flags.filter(f => f.severity !== 'LOW') ?? []

  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      <div className="w-full max-w-2xl space-y-5">
        {/* Header */}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-base">⚡</span>
            <h2 className="text-sm font-semibold text-red-400">Conflict Escalated</h2>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
              after {round} round{round !== 1 ? 's' : ''}
            </span>
          </div>
          <p className="text-xs text-zinc-500">
            The reviewer still finds unresolved issues after {round} generation rounds.
            Your decision anchors both models — they will not debate after you answer.
          </p>
        </div>

        {/* Unresolved flags */}
        {highFlags.length > 0 && (
          <div className="rounded-lg border border-red-900/40 bg-red-950/10 p-4 space-y-2">
            <h3 className="text-xs font-medium text-red-400">Unresolved Issues</h3>
            {highFlags.map(f => (
              <div key={f.id} className="space-y-0.5">
                <p className="text-xs text-zinc-300">
                  <span className={cn(
                    'mr-1.5 rounded px-1 py-0.5 text-[10px] font-medium',
                    f.severity === 'HIGH' ? 'bg-red-900/60 text-red-400' : 'bg-yellow-900/60 text-yellow-400',
                  )}>
                    {f.severity}
                  </span>
                  {f.description}
                </p>
                {f.pseudo_code_hint && (
                  <p className="text-[10px] text-zinc-600 pl-10">Hint: {f.pseudo_code_hint}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {conflictReason && highFlags.length === 0 && (
          <div className="rounded border border-zinc-800 bg-zinc-900/40 px-4 py-3">
            <p className="text-xs text-zinc-400 whitespace-pre-wrap">{conflictReason}</p>
          </div>
        )}

        {/* Resolution input */}
        <form onSubmit={handleResolve} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">
              Your decision
            </label>
            <textarea
              value={override}
              onChange={e => setOverride(e.target.value)}
              placeholder={'Tell the models how to proceed…\nExample: "Accept the current implementation — the edge case is out of scope for this feature."'}
              rows={4}
              className="w-full resize-none rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
          </div>

          {error && (
            <p className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!override.trim() || resolving}
            className={cn(
              'w-full rounded px-4 py-2 text-sm font-medium transition-colors',
              override.trim() && !resolving
                ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
            )}
          >
            {resolving ? 'Applying decision…' : 'Apply Decision & Resume →'}
          </button>
        </form>
      </div>
    </div>
  )
}
