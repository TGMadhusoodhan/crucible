'use client'

import { useRef, useEffect } from 'react'
import { usePipelineState } from '@/store'

function PhaseStep({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={
        done   ? 'text-green-500' :
        active ? 'text-indigo-400 animate-pulse' :
                 'text-zinc-700'
      }>
        {done ? '✓' : active ? '●' : '○'}
      </span>
      <span className={`text-xs ${done ? 'text-zinc-400' : active ? 'text-zinc-200' : 'text-zinc-600'}`}>
        {label}
      </span>
    </div>
  )
}

export function GeneratingPanel() {
  const { streamingCode, selfCheckOutput, phase, round, project } = usePipelineState()
  const codeEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom as code streams in
  useEffect(() => {
    codeEndRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [streamingCode])

  const isGenerating  = phase === 'phase3_generating'
  const isSelfCheck   = phase === 'phase3_self_check'
  const isReviewing   = phase === 'phase3_reviewing'
  const isConsensus   = phase === 'phase3_consensus'

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-3">
        <h2 className="text-sm font-medium text-zinc-300">
          Phase 3 — Code Generation {round > 1 ? `(round ${round})` : ''}
        </h2>
        <div className="mt-2 flex gap-5">
          <PhaseStep label={`Generate (${project?.primaryModelId ?? 'primary'})`} active={isGenerating} done={!isGenerating && !!streamingCode} />
          <PhaseStep label="Self-Check" active={isSelfCheck} done={!isSelfCheck && !!selfCheckOutput} />
          <PhaseStep label={`Review (${project?.reviewerModelId ?? 'reviewer'})`} active={isReviewing} done={isConsensus} />
        </div>
      </div>

      {/* Self-check result (shown after generation, before review) */}
      {selfCheckOutput && (
        <div className={`border-b px-6 py-2 text-xs ${selfCheckOutput.all_clear ? 'border-green-900/30 bg-green-950/10 text-green-400' : 'border-yellow-900/30 bg-yellow-950/10 text-yellow-400'}`}>
          Self-check pass {selfCheckOutput.pass}/2: {selfCheckOutput.all_clear ? 'All clear' : `${selfCheckOutput.issues.length} issue(s) — patching…`}
        </div>
      )}

      {/* Streaming code */}
      <div className="flex-1 overflow-y-auto">
        {streamingCode ? (
          <pre className="min-h-full p-4 font-mono text-xs text-zinc-300 whitespace-pre-wrap">
            {streamingCode}
            {isGenerating && <span className="inline-block w-1.5 h-3 bg-indigo-400 animate-pulse ml-0.5 align-middle" />}
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
