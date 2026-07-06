'use client'

import { useEffect, useRef, useState } from 'react'
import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'

function FilePill({ label, status }: { label: string; status: 'done' | 'current' | 'pending' }) {
  return (
    <span className={cn(
      'rounded-full px-2.5 py-1 text-[10px] font-mono truncate max-w-[160px]',
      status === 'done'    ? 'bg-emerald-950/60 text-emerald-400' :
      status === 'current' ? 'bg-indigo-950/60 text-indigo-300 animate-pulse' :
                              'bg-zinc-900 text-zinc-700',
    )}>
      {status === 'done' ? '✓ ' : ''}{label}
    </span>
  )
}

export function GeneratingPanel() {
  const { currentFilename, currentFileIdx, totalFiles, streamingCode, fileManifest, acceptedFiles } = usePipelineState()
  const codeEndRef   = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      codeEndRef.current?.scrollIntoView({ behavior: 'instant' })
      scrollRafRef.current = null
    })
  }, [streamingCode])

  async function copyCode() {
    await navigator.clipboard.writeText(streamingCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const order = fileManifest?.generation_order ?? (currentFilename ? [currentFilename] : [])

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-medium text-zinc-300">
            Generating file {Math.min(currentFileIdx + 1, Math.max(totalFiles, 1))} of {Math.max(totalFiles, 1)}
            {currentFilename && `: ${currentFilename}`}
          </h2>
          {streamingCode && (
            <button
              onClick={() => void copyCode()}
              className="shrink-0 rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          )}
        </div>

        {order.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {order.map((filename, i) => {
              const status = acceptedFiles[filename] !== undefined
                ? 'done'
                : i === currentFileIdx
                ? 'current'
                : 'pending'
              return <FilePill key={filename} label={filename} status={status} />
            })}
          </div>
        )}
      </div>

      {/* Streaming code */}
      <div className="flex-1 overflow-y-auto">
        {streamingCode ? (
          <pre className="min-h-full p-4 font-mono text-xs text-zinc-300 whitespace-pre-wrap">
            {streamingCode}
            <span className="inline-block w-1.5 h-3 bg-indigo-400 animate-pulse ml-0.5 align-middle" />
          </pre>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-zinc-600 animate-pulse">Starting generation…</p>
          </div>
        )}
        <div ref={codeEndRef} />
      </div>
    </div>
  )
}
