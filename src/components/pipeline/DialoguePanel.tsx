'use client'

import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'

export function DialoguePanel() {
  const { dialogue, project, phase } = usePipelineState()

  const coderLabel    = project?.primaryModelId  ?? 'Coder'
  const reviewerLabel = project?.reviewerModelId ?? 'Reviewer'

  const isActive = phase === 'phase3_dialogue'

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-3">
        <h2 className="text-sm font-medium text-zinc-300">Phase 3 — Model Dialogue</h2>
        <p className="mt-1 text-xs text-zinc-600">
          Coder and reviewer resolving disagreement on reviewer&apos;s edits (up to 3 rounds)
        </p>
        {dialogue && (
          <p className="mt-0.5 text-[10px] text-zinc-700">
            Round {dialogue.rounds}/3 {dialogue.resolved ? '— Resolved ✓' : isActive ? '— In progress…' : '— Escalated'}
          </p>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {!dialogue || dialogue.messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-zinc-600 animate-pulse">Starting dialogue…</p>
          </div>
        ) : (
          dialogue.messages.map((msg, i) => {
            const isCoder    = msg.actor === 'coder'
            const label      = isCoder ? coderLabel : reviewerLabel
            const isResolved = msg.resolved

            return (
              <div
                key={i}
                className={cn(
                  'flex gap-3',
                  isCoder ? 'flex-row' : 'flex-row-reverse',
                )}
              >
                {/* Avatar */}
                <div className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-mono font-medium self-start mt-0.5',
                  isCoder ? 'bg-indigo-900/60 text-indigo-400' : 'bg-emerald-900/60 text-emerald-400',
                )}>
                  {isCoder ? 'C' : 'R'}
                </div>

                {/* Bubble */}
                <div className={cn(
                  'max-w-[80%] rounded-lg px-3 py-2 space-y-1',
                  isCoder ? 'bg-zinc-800/60' : 'bg-zinc-900/80 border border-zinc-800',
                )}>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-medium text-zinc-400">{label}</span>
                    <span className="text-[9px] text-zinc-700">Round {msg.round}</span>
                    {isResolved && <span className="text-[9px] text-green-500">✓ Resolved</span>}
                  </div>
                  <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">
                    {msg.content}
                  </p>
                </div>
              </div>
            )
          })
        )}

        {isActive && dialogue && dialogue.messages.length > 0 && !dialogue.resolved && (
          <div className="flex gap-3">
            <div className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-mono bg-zinc-800 text-zinc-600 self-start mt-0.5">…</div>
            <div className="rounded-lg px-3 py-2 bg-zinc-800/30">
              <p className="text-xs text-zinc-600 animate-pulse">Waiting for response…</p>
            </div>
          </div>
        )}
      </div>

      {/* Status footer */}
      {dialogue?.resolved && (
        <div className="border-t border-green-900/30 bg-green-950/10 px-6 py-2">
          <p className="text-xs text-green-400">✓ Models reached agreement — promoting reviewer&apos;s edits</p>
        </div>
      )}
      {dialogue && !dialogue.resolved && !isActive && (
        <div className="border-t border-red-900/30 bg-red-950/10 px-6 py-2">
          <p className="text-xs text-red-400">Escalating to human review after {dialogue.rounds} rounds</p>
        </div>
      )}
    </div>
  )
}
