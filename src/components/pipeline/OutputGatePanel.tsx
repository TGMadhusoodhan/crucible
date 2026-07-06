'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import { usePipeline } from '@/hooks/usePipeline'
import { usePipelineDispatch, usePipelineState } from '@/store'
import { cn } from '@/lib/utils'

// Monaco is heavy — lazy load it
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <span className="text-xs text-zinc-600">Loading editor…</span>
    </div>
  ),
  ssr: false,
})

export function OutputGatePanel() {
  const { acceptedFiles, phase } = usePipelineState()
  const dispatch = usePipelineDispatch()
  const { acceptOutput, requestOutputFix } = usePipeline()

  const filenames = Object.keys(acceptedFiles)
  const [selected, setSelected]     = useState<string | null>(filenames[0] ?? null)
  const [gateAccepted, setGateAccepted] = useState<Set<string>>(new Set())
  const [accepting, setAccepting]   = useState(false)
  const [showFixBox, setShowFixBox] = useState(false)
  const [fixText, setFixText]       = useState('')
  const [fixing, setFixing]         = useState(false)
  const [error, setError]           = useState<string | null>(null)

  const currentFilename = selected ?? filenames[0] ?? null
  const currentCode     = currentFilename ? acceptedFiles[currentFilename] ?? '' : ''
  const allAccepted     = filenames.length > 0 && filenames.every(f => gateAccepted.has(f))

  async function handleAccept() {
    if (!currentFilename) return
    setError(null)
    setAccepting(true)
    try {
      await acceptOutput(currentFilename)
      setGateAccepted(prev => new Set(prev).add(currentFilename))
      const next = filenames.find(f => f !== currentFilename && !gateAccepted.has(f))
      if (next) setSelected(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept')
    } finally {
      setAccepting(false)
    }
  }

  async function handleRequestFix() {
    if (!currentFilename || !fixText.trim()) return
    setError(null)
    setFixing(true)
    try {
      const res = await requestOutputFix(currentFilename, fixText.trim()) as {
        success: boolean; data?: { code: string; modelId: string }; error?: string
      }
      if (!res.success || !res.data) throw new Error(res.error ?? 'Fix failed')
      // Reflect the fixed code in the viewer — FILE_ACCEPTED is the only action
      // that updates acceptedFiles[filename], so reuse it here purely for its
      // state effect (this does not mean the human has re-approved the file).
      dispatch({ type: 'FILE_ACCEPTED', filename: currentFilename, code: res.data.code })
      // Content just changed underneath — a prior accept no longer applies.
      setGateAccepted(prev => {
        const next = new Set(prev)
        next.delete(currentFilename)
        return next
      })
      setFixText('')
      setShowFixBox(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request fix')
    } finally {
      setFixing(false)
    }
  }

  if (filenames.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-zinc-600 animate-pulse">Loading files…</p>
      </div>
    )
  }

  if (allAccepted && phase === 'output_gate') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-emerald-400">✓ All files approved. Saving…</p>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* LEFT — file list */}
      <div className="w-64 shrink-0 border-r border-zinc-800 flex flex-col">
        <div className="border-b border-zinc-800 px-3 py-2.5">
          <p className="text-xs font-medium text-zinc-300">Output gate</p>
          <p className="text-[10px] text-zinc-600">
            {gateAccepted.size} of {filenames.length} files accepted
          </p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filenames.map(f => {
            const isAccepted = gateAccepted.has(f)
            return (
              <button
                key={f}
                onClick={() => { setSelected(f); setShowFixBox(false); setError(null) }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                  f === currentFilename ? 'bg-zinc-800' : 'hover:bg-zinc-800/50',
                )}
              >
                <span className={cn('shrink-0 text-xs', isAccepted ? 'text-emerald-500' : 'text-zinc-700')}>
                  {isAccepted ? '✓' : '○'}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">{f}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* RIGHT — file viewer */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
          <span className="text-xs text-zinc-400 truncate">{currentFilename}</span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowFixBox(v => !v)}
              className="rounded border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
            >
              Request fix
            </button>
            <button
              onClick={() => void handleAccept()}
              disabled={accepting || (currentFilename ? gateAccepted.has(currentFilename) : true)}
              className={cn(
                'rounded px-3 py-1 text-[11px] font-medium transition-colors',
                currentFilename && gateAccepted.has(currentFilename)
                  ? 'bg-zinc-800 text-emerald-500 cursor-default'
                  : 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40',
              )}
            >
              {currentFilename && gateAccepted.has(currentFilename)
                ? '✓ Accepted'
                : accepting ? 'Accepting…' : 'Accept'}
            </button>
          </div>
        </div>

        {showFixBox && (
          <div className="border-b border-zinc-800 p-3 space-y-2">
            <textarea
              value={fixText}
              onChange={e => setFixText(e.target.value)}
              rows={3}
              placeholder="Describe the change you want to this file…"
              className="w-full resize-none rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
            <div className="flex gap-2">
              <button
                onClick={() => void handleRequestFix()}
                disabled={!fixText.trim() || fixing}
                className={cn(
                  'rounded px-3 py-1.5 text-xs font-medium transition-colors',
                  fixText.trim() && !fixing
                    ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                    : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
                )}
              >
                {fixing ? 'Applying…' : 'Submit'}
              </button>
              <button
                onClick={() => setShowFixBox(false)}
                className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {error && (
          <p className="border-b border-red-900/40 bg-red-950/20 px-4 py-2 text-xs text-red-400">{error}</p>
        )}

        <div className="flex-1 overflow-hidden">
          <MonacoEditor
            height="100%"
            path={currentFilename ?? undefined}
            value={currentCode}
            theme="vs-dark"
            options={{
              readOnly:             true,
              minimap:              { enabled: false },
              fontSize:             13,
              lineNumbers:          'on',
              scrollBeyondLastLine: false,
              wordWrap:             'on',
              renderLineHighlight:  'none',
              overviewRulerLanes:   0,
            }}
          />
        </div>
      </div>
    </div>
  )
}
