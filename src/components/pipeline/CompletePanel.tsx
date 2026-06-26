'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePipelineState } from '@/store'
import { usePipeline } from '@/hooks/usePipeline'
import { cn } from '@/lib/utils'

export function CompletePanel() {
  const { output, lastReview, acceptedFiles, spec } = usePipelineState()
  const { startPipeline } = usePipeline()

  const [showContinue, setShowContinue]   = useState(false)
  const [continueTask, setContinueTask]   = useState('')
  const [continuing,   setContinuing]     = useState(false)
  const [continueErr,  setContinueErr]    = useState<string | null>(null)

  const fileMap    = Object.keys(acceptedFiles).length > 0 ? acceptedFiles : (output?.files ?? {})
  const fileNames  = Object.keys(fileMap)
  const fileCount  = fileNames.length
  const roundCount = output?.review.round ?? 1
  const lowNotes   = lastReview?.flags.filter(f => f.severity === 'LOW').length ?? 0

  // Build codebase context from accepted files — injected into the follow-up session.
  // Total capped at 35k chars (below the 40k Zod limit) with per-file cap of 4k chars.
  function buildContinueContext(): string {
    const TOTAL_CAP    = 35_000
    const PER_FILE_CAP = 4_000
    const parts: string[] = [
      'ALREADY GENERATED FILES (do not regenerate these — generate the missing ones only):',
      '',
    ]
    let total = parts[0]!.length
    for (const [filename, content] of Object.entries(fileMap)) {
      const snippet  = content.slice(0, PER_FILE_CAP)
      const block    = `=== FILE: ${filename} ===\n${snippet}${content.length > PER_FILE_CAP ? '\n... [truncated]' : ''}\n=== /FILE ===\n`
      if (total + block.length > TOTAL_CAP) break
      parts.push(block)
      total += block.length
    }
    if (spec?.task_description) {
      const taskLine = `ORIGINAL TASK:\n${spec.task_description.slice(0, 1000)}`
      if (total + taskLine.length <= TOTAL_CAP) parts.push(taskLine)
    }
    return parts.join('\n')
  }

  async function handleContinue() {
    if (!continueTask.trim()) return
    setContinueErr(null)
    setContinuing(true)
    try {
      await startPipeline(continueTask.trim(), buildContinueContext())
    } catch (err) {
      setContinueErr(err instanceof Error ? err.message : 'Failed to start')
      setContinuing(false)
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center bg-zinc-950 p-8 overflow-y-auto">
      <div className="w-full max-w-sm space-y-6">

        {/* Status */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-indigo-400">✓</span>
            <span className="font-mono text-sm font-semibold text-zinc-100">Pipeline complete</span>
          </div>
          <p className="font-mono text-[10px] text-zinc-600 leading-relaxed">
            {fileCount} file{fileCount !== 1 ? 's' : ''} generated
            {' · '}{roundCount} review round{roundCount !== 1 ? 's' : ''}
            {lowNotes > 0 && ` · ${lowNotes} low-priority note${lowNotes !== 1 ? 's' : ''}`}
          </p>
        </div>

        {/* Accepted files list */}
        {fileCount > 0 && (
          <div className="rounded-sm border border-zinc-800 overflow-hidden">
            <div className="border-b border-zinc-800 px-4 py-2">
              <span className="font-mono text-[9px] uppercase tracking-widest text-zinc-600">Output</span>
            </div>
            <div className="divide-y divide-zinc-800/60">
              {fileNames.map(filename => {
                const parts    = filename.split('/')
                const basename = parts.pop() ?? filename
                const dir      = parts.length > 0 ? parts.join('/') + '/' : ''
                const ext      = basename.split('.').pop() ?? ''
                return (
                  <div key={filename} className="flex items-center justify-between px-4 py-2">
                    <span className="font-mono text-[11px] text-zinc-400 truncate min-w-0 mr-2">
                      <span className="text-zinc-600">{dir}</span>
                      <span className="text-zinc-200">{basename.replace(/\.[^.]+$/, '')}</span>
                      {ext && <span className="text-indigo-400">.{ext}</span>}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-indigo-500">✓</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Link to Files section */}
        <Link
          href="/files"
          className="flex items-center justify-between rounded-sm border border-zinc-700 px-4 py-3 transition-colors hover:border-indigo-600/50 hover:bg-indigo-950/10 group"
        >
          <div className="space-y-0.5">
            <p className="font-mono text-xs text-zinc-300 group-hover:text-zinc-100 transition-colors">
              Open Files →
            </p>
            <p className="font-mono text-[10px] text-zinc-600">
              View, download, and modify any generated file
            </p>
          </div>
          <span className="shrink-0 rounded-sm border border-zinc-700 px-2 py-1 font-mono text-[9px] text-zinc-500">
            {fileCount} {fileCount === 1 ? 'file' : 'files'}
          </span>
        </Link>

        {/* Continue — generate remaining files */}
        {!showContinue ? (
          <button
            onClick={() => {
              setContinueTask(
                spec?.task_description
                  ? `Continue the original task. Generate the remaining files that are still missing. Original task: ${spec.task_description.slice(0, 300)}`
                  : 'Generate the remaining files that are still missing from this task.'
              )
              setShowContinue(true)
            }}
            className="w-full rounded-sm border border-zinc-800 px-4 py-2.5 font-mono text-xs text-zinc-500 hover:border-zinc-600 hover:text-zinc-300 transition-colors text-left"
          >
            + Generate missing files
            <span className="ml-2 text-zinc-700">→ starts a new session with your accepted files as context</span>
          </button>
        ) : (
          <div className="space-y-3 rounded-sm border border-zinc-700 p-4">
            <div className="space-y-1">
              <p className="font-mono text-[10px] text-zinc-400 font-semibold">Continue this task</p>
              <p className="font-mono text-[10px] text-zinc-600">
                Your {fileCount} accepted file{fileCount !== 1 ? 's' : ''} will be passed as codebase context.
                Describe what still needs to be built.
              </p>
            </div>

            <textarea
              value={continueTask}
              onChange={e => setContinueTask(e.target.value)}
              rows={4}
              autoFocus
              className="w-full resize-none rounded-sm border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 placeholder-zinc-700 focus:border-zinc-500 focus:outline-none transition-colors"
              placeholder="Describe the remaining files or components to generate…"
            />

            {continueErr && (
              <p className="font-mono text-xs text-red-400">{continueErr}</p>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={handleContinue}
                disabled={!continueTask.trim() || continuing}
                className={cn(
                  'flex-1 rounded-sm py-2 font-mono text-xs font-semibold transition-colors',
                  continueTask.trim() && !continuing
                    ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                    : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
                )}
              >
                {continuing ? 'Starting…' : 'Continue →'}
              </button>
              <button
                onClick={() => setShowContinue(false)}
                className="rounded-sm border border-zinc-800 px-3 py-2 font-mono text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
