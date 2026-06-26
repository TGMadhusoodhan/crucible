'use client'

import Link from 'next/link'
import { usePipelineState } from '@/store'

export function CompletePanel() {
  const { output, lastReview, acceptedFiles } = usePipelineState()

  const fileMap      = Object.keys(acceptedFiles).length > 0
    ? acceptedFiles
    : (output?.files ?? {})
  const fileNames    = Object.keys(fileMap)
  const fileCount    = fileNames.length
  const roundCount   = output?.review.round ?? 1
  const lowNotes     = lastReview?.flags.filter(f => f.severity === 'LOW').length ?? 0

  return (
    <div className="flex h-full flex-col items-center justify-center bg-zinc-950 p-8">
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
              <span className="font-mono text-[9px] uppercase tracking-widest text-zinc-600">
                Output
              </span>
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

      </div>
    </div>
  )
}
