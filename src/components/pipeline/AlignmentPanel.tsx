'use client'

import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'
import type { AlignmentMessage } from '@/types'

function MessageBubble({ msg, project }: { msg: AlignmentMessage; project: { r1ModelId: string; r2ModelId: string } | null }) {
  const isPrimary  = msg.actor === 'primary'
  const modelLabel = isPrimary ? (project?.r1ModelId ?? 'R1') : (project?.r2ModelId ?? 'R2')

  return (
    <div className={cn('flex flex-col gap-1', isPrimary ? 'items-start' : 'items-end')}>
      <span className="text-[10px] text-zinc-600">
        {modelLabel} · Round {msg.round}
      </span>
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-3 py-2 text-xs leading-relaxed',
          isPrimary
            ? 'bg-zinc-800 text-zinc-200'
            : 'bg-indigo-950/60 border border-indigo-800/40 text-indigo-200',
        )}
      >
        <p className="text-zinc-400 text-[10px] mb-1">"{msg.understood_as}"</p>
        <p>{msg.position}</p>
        {msg.questions_summary.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-zinc-500">
            {msg.questions_summary.map((q, i) => (
              <li key={i}>→ {q}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function AlignmentPanel() {
  const { alignmentMessages, project, phase } = usePipelineState()
  const isActive = phase === 'phase1_5_alignment'

  return (
    <div className="flex h-full flex-col p-6 space-y-4">
      <div className="space-y-0.5">
        <h2 className="text-sm font-medium text-zinc-300">Phase 1.5 — Alignment</h2>
        <p className="text-xs text-zinc-600">
          Models compare interpretations. Up to 2 rounds. Conflicts surface as questions.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3">
        {alignmentMessages.length === 0 && (
          <p className="text-xs text-zinc-600 italic text-center pt-4">Waiting for alignment messages…</p>
        )}
        {alignmentMessages.map(msg => (
          <MessageBubble key={msg.id} msg={msg} project={project} />
        ))}
        {isActive && alignmentMessages.length > 0 && (
          <div className="flex justify-center">
            <span className="text-xs text-zinc-600 italic animate-pulse">thinking…</span>
          </div>
        )}
      </div>
    </div>
  )
}
