'use client'

import { useState } from 'react'
import { usePipeline } from '@/hooks/usePipeline'
import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'

export function SpecPanel() {
  const { spec }        = usePipelineState()
  const { confirmSpec } = usePipeline()
  const [confirming, setConfirming] = useState(false)
  const [error, setError]           = useState<string | null>(null)

  if (!spec) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-zinc-600 animate-pulse">Generating spec…</p>
      </div>
    )
  }

  async function handleConfirm() {
    setError(null)
    setConfirming(true)
    try {
      await confirmSpec()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirm failed')
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-zinc-300">Phase 2 — Spec Review</h2>
          <p className="text-xs text-zinc-600">
            {spec.acceptance_criteria.length} criteria · {spec.edge_cases.length} edge cases
          </p>
        </div>
        <button
          onClick={handleConfirm}
          disabled={confirming}
          className={cn(
            'rounded px-4 py-1.5 text-xs font-medium transition-colors',
            !confirming
              ? 'bg-indigo-600 text-white hover:bg-indigo-500'
              : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
          )}
        >
          {confirming ? 'Starting…' : 'Confirm & Generate Code →'}
        </button>
      </div>

      {/* Spec content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {error && (
          <p className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-400">
            {error}
          </p>
        )}

        {/* Task */}
        <div>
          <h3 className="mb-2 text-xs font-medium text-zinc-400 uppercase tracking-wide">Task</h3>
          <p className="text-sm text-zinc-200">{spec.task_description}</p>
        </div>

        {/* Acceptance Criteria */}
        {spec.acceptance_criteria.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-medium text-zinc-400 uppercase tracking-wide">
              Acceptance Criteria
            </h3>
            <ul className="space-y-2">
              {spec.acceptance_criteria.map((c, i) => (
                <li key={c.id} className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                  <p className="text-xs text-zinc-200">{i + 1}. {c.description}</p>
                  <p className="mt-0.5 text-[10px] text-zinc-600">Test: {c.test_case}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Edge Cases */}
        {spec.edge_cases.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-medium text-zinc-400 uppercase tracking-wide">
              Edge Cases
            </h3>
            <ul className="space-y-2">
              {spec.edge_cases.map(e => (
                <li key={e.id} className="rounded border border-yellow-900/30 bg-yellow-950/10 px-3 py-2">
                  <p className="text-xs font-medium text-yellow-400">{e.scenario}</p>
                  <p className="text-xs text-zinc-400">{e.expected_behavior}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Error Messages */}
        {spec.error_messages.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-medium text-zinc-400 uppercase tracking-wide">
              Error Handling
            </h3>
            <ul className="space-y-2">
              {spec.error_messages.map(e => (
                <li key={e.id} className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                  <p className="text-xs text-zinc-300">{e.trigger}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">"{e.message}"</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Model defaults (transparency) */}
        {Object.keys(spec.model_defaults).length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-medium text-zinc-600 uppercase tracking-wide">
              Model Defaults (unanswered questions)
            </h3>
            <p className="text-[10px] text-zinc-600">
              These are assumptions the model made for optional questions you didn't answer.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
