'use client'

import { useState } from 'react'
import { usePipeline } from '@/hooks/usePipeline'
import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'

export function TaskInputPanel() {
  const state = usePipelineState()
  const { startPipeline } = usePipeline()
  const [task, setTask]         = useState('')
  const [context, setContext]   = useState('')
  const [showContext, setShow]  = useState(false)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  if (!state.project) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-zinc-500">Select or create a project to begin.</p>
      </div>
    )
  }

  async function handleStart(e: React.FormEvent) {
    e.preventDefault()
    const t = task.trim()
    if (!t || !state.project) return
    setError(null)
    setLoading(true)
    try {
      await startPipeline(state.project, t, context.trim() || undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start pipeline')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center p-8">
      <div className="w-full max-w-2xl space-y-4">
        {/* Header */}
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{state.project.name}</h2>
          <p className="text-xs text-zinc-500">
            DeepSeek <span className="text-zinc-700">→</span>{' '}
            {state.project.r1ModelId} + {state.project.r2ModelId}
          </p>
        </div>

        <form onSubmit={handleStart} className="space-y-3">
          {/* Task */}
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">
              What should we build?
            </label>
            <p className="mb-1.5 text-[10px] text-zinc-600">
              Describe what it does, who uses it, and any constraints. The models will ask before building.
            </p>
            <textarea
              value={task}
              onChange={e => setTask(e.target.value)}
              placeholder="Describe the feature, function, or problem to solve…"
              rows={5}
              className="w-full resize-none rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
          </div>

          {/* Context toggle */}
          <button
            type="button"
            onClick={() => setShow(v => !v)}
            className="flex items-center gap-1.5 rounded border border-zinc-700/60 px-3 py-1.5 text-xs text-zinc-500 hover:border-zinc-600 hover:text-zinc-300 transition-colors"
          >
            <span>{showContext ? '−' : '+'}</span>
            <span>{showContext ? 'Hide codebase context' : 'Add codebase context'}</span>
          </button>

          {showContext && (
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Codebase context (paste relevant code or file contents)
              </label>
              <textarea
                value={context}
                onChange={e => setContext(e.target.value)}
                placeholder="Paste any existing code, architecture notes, or file contents here…"
                rows={8}
                className="w-full resize-y rounded border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-300 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              />
            </div>
          )}

          {error && (
            <p className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!task.trim() || loading}
            className={cn(
              'w-full rounded px-4 py-2.5 text-sm font-medium transition-colors',
              task.trim() && !loading
                ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
            )}
          >
            {loading ? 'Starting…' : 'Start Pipeline'}
          </button>
        </form>
      </div>
    </div>
  )
}
