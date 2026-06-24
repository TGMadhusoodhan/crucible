'use client'

import { useState } from 'react'
import { usePipeline } from '@/hooks/usePipeline'
import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'

type Choice = 'coder' | 'reviewer' | 'custom'

export function ConflictPanel() {
  const { lastReview, conflictReason, round, dialogue } = usePipelineState()
  const { resolveConflict } = usePipeline()

  const [choice, setChoice]   = useState<Choice | null>(null)
  const [custom, setCustom]   = useState('')
  const [resolving, setResolving] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  const coderPosition    = dialogue?.coderFinalPosition    ?? ''
  const reviewerPosition = dialogue?.reviewerFinalPosition ?? ''
  const hasDialogue      = Boolean(dialogue && dialogue.rounds > 0)

  const highFlags = lastReview?.flags.filter(f => f.severity !== 'LOW') ?? []

  function getOverrideMessage(): string {
    if (choice === 'coder')    return `HUMAN DECISION: Follow the coder's approach.\n\nCoder's final position: ${coderPosition}`
    if (choice === 'reviewer') return `HUMAN DECISION: Follow the reviewer's approach.\n\nReviewer's final position: ${reviewerPosition}`
    return `HUMAN DECISION: ${custom.trim()}`
  }

  const canSubmit = choice === 'coder' || choice === 'reviewer' || (choice === 'custom' && custom.trim().length > 0)

  async function handleResolve(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setError(null)
    setResolving(true)
    try {
      await resolveConflict(getOverrideMessage())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resolution failed')
    } finally {
      setResolving(false)
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      <div className="w-full max-w-2xl space-y-5">

        {/* Header */}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-base">⚡</span>
            <h2 className="text-sm font-semibold text-red-400">Human Arbitration Required</h2>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
              {hasDialogue
                ? `after ${dialogue!.rounds} dialogue round${dialogue!.rounds !== 1 ? 's' : ''}`
                : `after ${round} review round${round !== 1 ? 's' : ''}`}
            </span>
          </div>
          <p className="text-xs text-zinc-500">
            {hasDialogue
              ? 'The models could not resolve their disagreement. Pick which position to follow — your choice is final.'
              : 'The reviewer found unresolved issues. Your decision anchors both models.'}
          </p>
        </div>

        {/* Unresolved flags (shown when no dialogue) */}
        {!hasDialogue && highFlags.length > 0 && (
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
              </div>
            ))}
          </div>
        )}

        {/* 3-option picker */}
        <form onSubmit={handleResolve} className="space-y-3">
          <label className="mb-1 block text-xs font-medium text-zinc-400">Your decision</label>

          {/* Option 1: Follow coder */}
          <label className={cn(
            'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
            choice === 'coder' ? 'border-indigo-600 bg-indigo-950/20' : 'border-zinc-700 hover:border-zinc-600',
          )}>
            <input
              type="radio"
              name="choice"
              value="coder"
              className="mt-0.5 shrink-0 accent-indigo-500"
              checked={choice === 'coder'}
              onChange={() => setChoice('coder')}
            />
            <div className="min-w-0">
              <p className="text-xs font-medium text-zinc-200">
                Follow Coder&apos;s approach
                <span className="ml-1.5 rounded bg-zinc-800 px-1 text-[10px] text-zinc-500">{lastReview?.round ?? '—'} rounds</span>
              </p>
              {coderPosition ? (
                <p className="mt-1 text-[10px] text-zinc-500 leading-relaxed line-clamp-3">{coderPosition}</p>
              ) : (
                <p className="mt-1 text-[10px] text-zinc-600 italic">Use the coder&apos;s last generated code as-is</p>
              )}
            </div>
          </label>

          {/* Option 2: Follow reviewer */}
          <label className={cn(
            'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
            choice === 'reviewer' ? 'border-indigo-600 bg-indigo-950/20' : 'border-zinc-700 hover:border-zinc-600',
          )}>
            <input
              type="radio"
              name="choice"
              value="reviewer"
              className="mt-0.5 shrink-0 accent-indigo-500"
              checked={choice === 'reviewer'}
              onChange={() => setChoice('reviewer')}
            />
            <div className="min-w-0">
              <p className="text-xs font-medium text-zinc-200">Follow Reviewer&apos;s approach</p>
              {reviewerPosition ? (
                <p className="mt-1 text-[10px] text-zinc-500 leading-relaxed line-clamp-3">{reviewerPosition}</p>
              ) : (
                <p className="mt-1 text-[10px] text-zinc-600 italic">{conflictReason ?? 'Apply the reviewer\'s suggested fixes'}</p>
              )}
            </div>
          </label>

          {/* Option 3: Custom */}
          <label className={cn(
            'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
            choice === 'custom' ? 'border-indigo-600 bg-indigo-950/20' : 'border-zinc-700 hover:border-zinc-600',
          )}>
            <input
              type="radio"
              name="choice"
              value="custom"
              className="mt-0.5 shrink-0 accent-indigo-500"
              checked={choice === 'custom'}
              onChange={() => setChoice('custom')}
            />
            <div className="min-w-0 w-full">
              <p className="text-xs font-medium text-zinc-200">Custom instruction</p>
              {choice === 'custom' && (
                <textarea
                  value={custom}
                  onChange={e => setCustom(e.target.value)}
                  placeholder="Tell both models exactly how to proceed…"
                  rows={3}
                  autoFocus
                  className="mt-2 w-full resize-none rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                />
              )}
            </div>
          </label>

          {error && (
            <p className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!canSubmit || resolving}
            className={cn(
              'w-full rounded px-4 py-2 text-sm font-medium transition-colors',
              canSubmit && !resolving
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
