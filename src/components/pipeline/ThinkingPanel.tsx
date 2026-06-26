'use client'

import { useState } from 'react'
import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'
import type { ThinkingOutput } from '@/types'

function PulsingDot() {
  return <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">{title}</p>
      {children}
    </div>
  )
}

function ModelCard({
  label, output, compact, role,
}: {
  label:   string
  output:  ThinkingOutput | null
  compact: boolean
  role:    'coder' | 'reviewer'
}) {
  const [showAssumptions, setShowAssumptions] = useState(false)
  const [expanded, setExpanded]               = useState(!compact)

  const railCls = role === 'coder' ? 'bg-coder-600/70' : 'bg-reviewer-600/60'

  return (
    <div className={cn(
      'rounded-lg border border-zinc-800 bg-zinc-900/60 overflow-hidden flex',
      compact ? '' : 'max-h-[520px]',
    )}>
      {/* Dual rail — amber for coder, steel blue for reviewer */}
      <div className={cn('w-0.5 shrink-0', railCls)} />

      {/* Card content */}
      <div className={cn(
        'flex-1 min-w-0 overflow-hidden',
        compact ? '' : 'p-4 space-y-3 overflow-y-auto',
      )}>
        {/* Header — always visible */}
        <div
          className={cn('flex items-center gap-2', compact && 'cursor-pointer px-3 py-2 hover:bg-zinc-800/40')}
          onClick={compact ? () => setExpanded(v => !v) : undefined}
        >
          {compact && (
            <span className="text-[10px] text-zinc-600">{expanded ? '▾' : '▸'}</span>
          )}
          <span className="text-xs font-semibold text-zinc-300 truncate">{label}</span>
          {!output && <PulsingDot />}
          {output && (
            <span className="rounded bg-green-900/40 px-1.5 py-0.5 text-[10px] text-green-400 shrink-0">
              done
            </span>
          )}
        </div>

        {/* Body */}
        {(!compact || expanded) && (
          <div className={cn('text-xs', compact ? 'px-3 pb-3 space-y-2' : 'space-y-3')}>
          {!output ? (
            <p className="text-zinc-600 italic">Thinking independently…</p>
          ) : (
            <>
              <Section title="Interpretation">
                <p className="text-zinc-200 leading-relaxed">{output.understood_as}</p>
              </Section>

              {output.recommended_approach && (
                <Section title={compact ? 'Approach' : 'Proposed approach'}>
                  <p className="text-zinc-300 leading-relaxed">{output.recommended_approach}</p>
                </Section>
              )}

              {!compact && output.questions.length > 0 && (
                <Section title={`Implementation forks (${output.questions.length})`}>
                  <ul className="space-y-1.5">
                    {output.questions.map((q) => (
                      <li key={q.id} className="rounded border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5">
                        <p className="text-zinc-200">{q.text}</p>
                        {q.recommended_option_id && (
                          <p className="mt-0.5 text-zinc-500 text-[10px]">
                            Recommends:{' '}
                            <span className="text-indigo-400">
                              {q.options.find(o => o.id === q.recommended_option_id)?.label ?? '—'}
                            </span>
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {output.risks.length > 0 && (
                <Section title="Risks">
                  <ul className="space-y-0.5">
                    {output.risks.map((r, i) => (
                      <li key={i} className="flex gap-1.5 text-zinc-400">
                        <span className="text-yellow-600 shrink-0">⚠</span>
                        <span>{r}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {!compact && output.assumptions.length > 0 && (
                <Section title="Assumptions">
                  <button
                    onClick={() => setShowAssumptions(v => !v)}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    {showAssumptions ? '▾ Hide' : `▸ Show ${output.assumptions.length}`}
                  </button>
                  {showAssumptions && (
                    <ul className="mt-1 space-y-0.5">
                      {output.assumptions.map((a) => (
                        <li key={a.id} className="flex gap-1.5 text-zinc-500">
                          <span className="text-zinc-700 shrink-0 uppercase text-[9px] mt-px font-semibold">{a.category}</span>
                          <span>{a.description}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              )}
            </>
          )}
        </div>
        )}
      </div>
    </div>
  )
}

export function ThinkingPanel({ compact = false }: { compact?: boolean }) {
  const { thinkingPrimary, thinkingReviewer, project, phase } = usePipelineState()

  if (compact) {
    // Sidebar mode — narrow column alongside Q&A or spec
    return (
      <div className="flex h-full flex-col border-zinc-800">
        <div className="border-b border-zinc-800 px-3 py-2 shrink-0">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
            Model Analysis
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          <ModelCard
            label={project?.primaryModelId ?? 'Primary'}
            output={thinkingPrimary}
            compact
            role="coder"
          />
          <ModelCard
            label={project?.reviewerModelId ?? 'Reviewer'}
            output={thinkingReviewer}
            compact
            role="reviewer"
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col p-6 space-y-4 overflow-hidden">
      <div className="space-y-0.5 shrink-0">
        <h2 className="text-sm font-medium text-zinc-300">Phase 1 — Parallel Thinking</h2>
        <p className="text-xs text-zinc-600">
          Both models analyse the task independently. Neither sees the other's output until alignment.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">
        <ModelCard label={project?.primaryModelId ?? 'Primary'}  output={thinkingPrimary}  compact={false} role="coder" />
        <ModelCard label={project?.reviewerModelId ?? 'Reviewer'} output={thinkingReviewer} compact={false} role="reviewer" />
      </div>

      {thinkingPrimary && thinkingReviewer && phase === 'phase1_thinking' && (
        <div className="flex items-center gap-2 rounded border border-indigo-800/40 bg-indigo-950/20 px-3 py-2 shrink-0">
          <PulsingDot />
          <span className="text-xs text-indigo-400">Both models done — proceeding…</span>
        </div>
      )}
    </div>
  )
}
