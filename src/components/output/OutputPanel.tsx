'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import { usePipelineState } from '@/store'
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

export function OutputPanel() {
  const { output, phase } = usePipelineState()
  const conflict = phase === 'conflict_escalated'
  const [tab, setTab] = useState<'code' | 'review'>('code')
  const [copied, setCopied] = useState(false)

  const code   = output?.code   ?? ''
  const review = output?.review ?? null

  async function copyCode() {
    if (!code) return
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex h-full flex-col bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <div className="flex gap-1">
          <TabBtn active={tab === 'code'}   onClick={() => setTab('code')}>Code</TabBtn>
          <TabBtn active={tab === 'review'} onClick={() => setTab('review')}>Review</TabBtn>
        </div>
        <div className="flex items-center gap-2">
          {output && (
            <span className="rounded bg-emerald-900 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
              ✓ CONSENSUS
            </span>
          )}
          {conflict && (
            <span className="rounded bg-orange-900 px-2 py-0.5 text-[10px] font-semibold text-orange-400">
              ⚠ CONFLICT
            </span>
          )}
          {code && (
            <button
              onClick={() => void copyCode()}
              className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 transition-colors"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {tab === 'code' ? (
          code ? (
            <MonacoEditor
              height="100%"
              defaultLanguage="typescript"
              value={code}
              theme="vs-dark"
              options={{
                readOnly:          true,
                minimap:           { enabled: false },
                fontSize:          13,
                lineNumbers:       'on',
                scrollBeyondLastLine: false,
                wordWrap:          'on',
                renderLineHighlight: 'none',
                overviewRulerLanes: 0,
              }}
            />
          ) : (
            <EmptyState />
          )
        ) : (
          review ? <ReviewPanel review={review} /> : <EmptyState />
        )}
      </div>
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded px-3 py-1 text-xs font-medium transition-colors',
        active ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
      )}
    >
      {children}
    </button>
  )
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <p className="text-sm text-zinc-600">No consensus output yet</p>
      <p className="text-xs text-zinc-700">Consensus code will appear here once the reviewer agrees</p>
    </div>
  )
}

function ReviewPanel({ review }: { review: NonNullable<ReturnType<typeof usePipelineState>['output']>['review'] }) {
  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 text-xs">
      <div className="flex items-center gap-2">
        <span className={cn(
          'rounded-full px-2 py-0.5 font-semibold text-[10px]',
          review.consensus ? 'bg-emerald-900 text-emerald-400' : 'bg-red-900 text-red-400',
        )}>
          {review.consensus ? 'CONSENSUS' : 'CONFLICT'}
        </span>
      </div>

      {review.reasoning && (
        <div>
          <p className="mb-1 font-medium text-zinc-400 uppercase tracking-wide text-[10px]">Reasoning</p>
          <p className="text-zinc-300 leading-relaxed">{review.reasoning}</p>
        </div>
      )}

      <ReviewSection label="Critical bugs"     items={review.critical_bugs}     color="text-red-400" />
      <ReviewSection label="Logic errors"      items={review.logic_errors}      color="text-orange-400" />
      <ReviewSection label="Edge cases missed" items={review.edge_cases_missed} color="text-yellow-400" />
      <ReviewSection label="Suggestions"       items={review.pseudo_code_hints} color="text-blue-400" />
    </div>
  )
}

function ReviewSection({ label, items, color }: { label: string; items: string[]; color: string }) {
  if (!items.length) return null
  return (
    <div>
      <p className={cn('mb-1 font-medium uppercase tracking-wide text-[10px]', color)}>{label}</p>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-zinc-300">· {item}</li>
        ))}
      </ul>
    </div>
  )
}
