'use client'

import { usePipeline } from '@/hooks/usePipeline'
import { usePipelineState } from '@/store'
import { TaskInputPanel }    from './TaskInputPanel'
import { ThinkingPanel }     from './ThinkingPanel'
import { AlignmentPanel }    from './AlignmentPanel'
import { QuestionsPanel }    from './QuestionsPanel'
import { SpecPanel }         from './SpecPanel'
import { GeneratingPanel }   from './GeneratingPanel'
import { ReviewingPanel }    from './ReviewingPanel'
import { CrossReviewPanel }  from './CrossReviewPanel'
import { MicroGatePanel }    from './MicroGatePanel'
import { PatchingPanel }     from './PatchingPanel'
import { ArbitrationPanel }  from './ArbitrationPanel'
import { OutputGatePanel }   from './OutputGatePanel'
import { CompletePanel }     from './CompletePanel'
import { cn } from '@/lib/utils'

const THINKING_SIDEBAR_PHASES = new Set([
  'phase1_5_alignment',
  'phase2_questions',
  'phase2_answering',
  'phase2_contradiction_check',
  'phase2_spec_and_manifest',
  'phase2_confirm',
])

// ─── Phase progress strip ─────────────────────────────────────────────────────

const PHASES = [
  { label: 'Think',    phases: ['phase1_thinking'] },
  { label: 'Align',    phases: ['phase1_5_alignment'] },
  { label: 'Q&A',      phases: ['phase2_questions', 'phase2_answering', 'phase2_contradiction_check'] },
  { label: 'Spec',     phases: ['phase2_spec_and_manifest', 'phase2_confirm'] },
  { label: 'Generate', phases: ['phase3_generating'] },
  { label: 'Review',   phases: [
      'phase3_reviewing', 'phase3_cross_review', 'phase3_micro_gate',
      'phase3_patching', 'phase3_re_review', 'phase3_arbitration',
    ] },
  { label: 'Approve',  phases: ['output_gate'] },
  { label: 'Done',     phases: ['complete'] },
]

function ProgressStrip() {
  const { phase } = usePipelineState()

  if (phase === 'idle' || phase === 'stopped' || phase === 'error') return null

  const currentIdx = PHASES.findIndex(p => p.phases.includes(phase))
  const isGate = phase === 'phase3_micro_gate' || phase === 'phase3_arbitration'

  return (
    <div className="flex items-center gap-0 border-b border-zinc-800 px-6 py-2 bg-zinc-950/60">
      {PHASES.map((step, i) => {
        const done   = i < currentIdx
        const active = i === currentIdx
        const gate   = isGate && step.label === 'Review'
        return (
          <div key={step.label} className="flex items-center">
            <span className={cn(
              'text-[10px] px-2 py-0.5 rounded-full transition-colors',
              gate               ? 'bg-amber-950/60 text-amber-400' :
              done               ? 'text-green-500' :
              active             ? 'bg-indigo-950/60 text-indigo-300' :
                                   'text-zinc-700',
            )}>
              {done ? '✓ ' : ''}{step.label}
            </span>
            {i < PHASES.length - 1 && (
              <span className="text-zinc-800 px-1">→</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Controls bar ─────────────────────────────────────────────────────────────

function ControlsBar() {
  const { phase, isStreaming, sessionId } = usePipelineState()
  const { pause, play, stop, resetSession } = usePipeline()

  if (!sessionId) return null

  const showPause = isStreaming && phase !== 'paused'
  const showPlay  = phase === 'paused'
  const showStop  = phase !== 'complete' && phase !== 'stopped' && phase !== 'idle'
  const showReset = phase === 'complete' || phase === 'stopped' || phase === 'error'

  if (!showPause && !showPlay && !showStop && !showReset) return null

  return (
    <div className="flex items-center gap-2 border-b border-zinc-800 px-6 py-2">
      {showPause && (
        <button
          onClick={pause}
          className="rounded px-3 py-1 text-xs text-zinc-400 border border-zinc-700 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
        >
          ⏸ Pause
        </button>
      )}
      {showPlay && (
        <button
          onClick={() => void play()}
          className="rounded px-3 py-1 text-xs text-indigo-400 border border-indigo-800 hover:border-indigo-600 transition-colors"
        >
          ▶ Resume
        </button>
      )}
      {showStop && (
        <button
          onClick={stop}
          className="rounded px-3 py-1 text-xs text-red-500 border border-red-900/50 hover:border-red-700 transition-colors"
        >
          ■ Stop
        </button>
      )}
      {showReset && (
        <button
          onClick={resetSession}
          className="rounded px-3 py-1 text-xs text-zinc-400 border border-zinc-700 hover:border-zinc-500 transition-colors"
        >
          ↺ New Session
        </button>
      )}
    </div>
  )
}

// ─── Error banner ─────────────────────────────────────────────────────────────

function ErrorBanner() {
  const { error, phase } = usePipelineState()
  const { resetSession } = usePipeline()
  if (!error) return null
  return (
    <div className={cn(
      'border-b px-6 py-3 space-y-1',
      phase === 'error'
        ? 'border-red-800 bg-red-950/40'
        : 'border-red-900/50 bg-red-950/20',
    )}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-red-400">Pipeline error</p>
        <button onClick={resetSession} className="text-xs text-zinc-500 hover:text-zinc-300">
          Dismiss &amp; retry
        </button>
      </div>
      <p className="text-xs text-red-300 break-words">{error}</p>
    </div>
  )
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function PipelineView() {
  const { phase, thinkingR1, thinkingR2 } = usePipelineState()

  // Show thinking panel as left sidebar when we're past the thinking phase
  // so the model analysis stays visible while the user reviews Q&A or spec.
  const hasThinking = thinkingR1 !== null || thinkingR2 !== null
  const showThinkingSidebar = hasThinking && THINKING_SIDEBAR_PHASES.has(phase)

  function renderMain() {
    switch (phase) {
      case 'idle':
      case 'stopped':
        return <TaskInputPanel />

      case 'phase1_thinking':
        return <ThinkingPanel />

      case 'phase1_5_alignment':
        return <AlignmentPanel />

      case 'phase2_questions':
      case 'phase2_answering':
      case 'phase2_contradiction_check':
        return <QuestionsPanel />

      case 'phase2_spec_and_manifest':
      case 'phase2_confirm':
        return <SpecPanel />

      case 'phase3_generating':
        return <GeneratingPanel />

      case 'phase3_reviewing':
      case 'phase3_re_review':
        return <ReviewingPanel />

      case 'phase3_cross_review':
        return <CrossReviewPanel />

      case 'phase3_micro_gate':
        return <MicroGatePanel />

      case 'phase3_patching':
        return <PatchingPanel />

      case 'phase3_arbitration':
        return <ArbitrationPanel />

      case 'output_gate':
        return <OutputGatePanel />

      case 'complete':
        return <CompletePanel />

      case 'paused':
        return (
          <div className="flex h-full items-center justify-center">
            <div className="text-center space-y-2">
              <p className="text-sm text-zinc-400">Pipeline paused</p>
              <p className="text-xs text-zinc-600">Click Resume to continue from where you left off.</p>
            </div>
          </div>
        )

      case 'error':
        return <TaskInputPanel />

      default:
        return <TaskInputPanel />
    }
  }

  return (
    <div className="flex h-full flex-col">
      <ProgressStrip />
      <ControlsBar />
      <ErrorBanner />
      <div className="flex-1 overflow-hidden flex">
        {showThinkingSidebar && (
          <div className="w-80 shrink-0 border-r border-zinc-800 overflow-hidden">
            <ThinkingPanel compact />
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          {renderMain()}
        </div>
      </div>
    </div>
  )
}
