'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'
import type { ConversationEvent, PipelinePhase } from '@/types'

// ─── Phase labels ─────────────────────────────────────────────────────────────

const PHASE_LABELS: Partial<Record<PipelinePhase, string>> = {
  phase1_thinking:            'Thinking',
  phase1_5_alignment:         'Alignment',
  phase2_questions:           'Questions',
  phase2_answering:           'Answering',
  phase2_contradiction_check: 'Contradiction Check',
  phase2_spec_and_manifest:   'Spec + Manifest',
  phase2_confirm:             'Confirm',
  phase3_generating:          'Generating',
  phase3_reviewing:           'Reviewing',
  phase3_cross_review:        'Cross-Review',
  phase3_micro_gate:          'Micro-Gate',
  phase3_patching:            'Patching',
  phase3_re_review:           'Re-Review',
  phase3_arbitration:         'Arbitration',
  output_gate:                'Output Gate',
  complete:                   'Complete',
}

// ─── Single event row ─────────────────────────────────────────────────────────

function EventRow({ event }: { event: ConversationEvent }) {
  const [expanded, setExpanded] = useState(false)
  const [fullContent, setFull]  = useState<string | null>(null)
  const { sessionId }           = usePipelineState()

  async function handleExpand() {
    if (!expanded && !fullContent && event.expandable && sessionId) {
      const res  = await fetch(`/api/conversation/${sessionId}?eventId=${event.id}`)
      const data = await res.json() as { success: boolean; data?: { fullContent?: string } }
      if (data.success && data.data?.fullContent) setFull(data.data.fullContent)
    }
    setExpanded(v => !v)
  }

  const indicatorColor =
    event.indicator === 'success'  ? 'text-green-500'  :
    event.indicator === 'error'    ? 'text-red-500'     :
    event.indicator === 'warning'  ? 'text-yellow-500'  :
    event.indicator === 'user'     ? 'text-blue-400'    :
                                     'text-zinc-600'

  const actorLabel =
    event.actor === 'human'      ? 'You'       :
    event.actor === 'system'     ? 'System'    :
    event.actor === 'coder'      ? 'Coder'     :
    event.actor === 'anthropic'  ? 'Claude'    :
    event.actor === 'deepseek'   ? 'DeepSeek'  :
    event.actor === 'openai'     ? 'OpenAI'    :
    event.actor === 'google'     ? 'Gemini'    :
    event.actor === 'mistral'    ? 'Mistral'   :
    event.actor === 'openrouter' ? 'OpenRouter':
    event.actor === 'groq'       ? 'Groq'      :
    event.actor === 'together'   ? 'Together'  :
    event.actor

  return (
    <div
      className={cn(
        'border-b border-zinc-800/50 px-3 py-2 transition-colors',
        event.expandable && 'cursor-pointer hover:bg-zinc-800/20',
        event.isConflict  && 'border-l-2 border-l-red-700',
        event.isConsensus && 'border-l-2 border-l-green-700',
      )}
      onClick={event.expandable ? handleExpand : undefined}
    >
      <div className="flex items-start gap-2">
        <span className={cn('shrink-0 mt-0.5 text-xs', indicatorColor)}>●</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-zinc-600">{actorLabel}</span>
            <span className="text-[10px] text-zinc-700">·</span>
            <span className="text-[10px] text-zinc-700">{PHASE_LABELS[event.phase] ?? event.phase}</span>
            {event.round !== undefined && (
              <span className="text-[10px] text-zinc-700">r{event.round}</span>
            )}
          </div>
          <p className="text-xs text-zinc-300 mt-0.5 leading-relaxed">{event.summary}</p>
          {expanded && (fullContent ?? event.fullContent) && (
            <pre className="mt-2 whitespace-pre-wrap text-[10px] text-zinc-500 leading-relaxed">
              {fullContent ?? event.fullContent}
            </pre>
          )}
          {event.expandable && (
            <span className="text-[10px] text-zinc-700 mt-0.5 block">
              {expanded ? '▲ collapse' : '▼ expand'}
            </span>
          )}
        </div>
        {event.costUsd !== undefined && event.costUsd > 0 && (
          <span className="shrink-0 text-[10px] text-zinc-700">
            ${event.costUsd.toFixed(4)}
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function ConversationPanel() {
  const { sessionId, phase } = usePipelineState()
  const [events, setEvents] = useState<ConversationEvent[]>([])
  const bottomRef    = useRef<HTMLDivElement>(null)
  const intervalRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  // Refs avoid stale closures in setInterval — reads always current value
  const cursorRef    = useRef<string | undefined>(undefined)
  const seenIdsRef   = useRef<Set<string>>(new Set())

  // loadEvents only depends on sessionId — stable reference, safe for setInterval
  const loadEvents = useCallback(async () => {
    if (!sessionId) return
    const url = `/api/conversation/${sessionId}?view=events${cursorRef.current ? `&since=${cursorRef.current}` : ''}`
    const res  = await fetch(url)
    if (!res.ok) return
    const data = await res.json() as { success: boolean; data?: ConversationEvent[] }
    if (!data.success || !data.data || data.data.length === 0) return

    // Deduplicate — belt-and-suspenders against any double fetch
    const fresh = data.data.filter(e => !seenIdsRef.current.has(e.id))
    if (fresh.length === 0) return

    fresh.forEach(e => seenIdsRef.current.add(e.id))
    setEvents(prev => [...prev, ...fresh])

    const last = fresh[fresh.length - 1]
    if (last) cursorRef.current = last.timestamp
  }, [sessionId])

  // Reset on session change
  useEffect(() => {
    setEvents([])
    cursorRef.current  = undefined
    seenIdsRef.current = new Set()
    if (!sessionId) return
    void loadEvents()
  }, [sessionId, loadEvents])

  // Poll while pipeline is active
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    const active = !['idle', 'complete', 'stopped', 'error'].includes(phase)
    if (active && sessionId) {
      intervalRef.current = setInterval(() => { void loadEvents() }, 3000)
    } else if (sessionId) {
      void loadEvents()  // one final drain after pipeline completes
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [phase, sessionId, loadEvents])

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events.length])

  return (
    <div className="flex h-full flex-col border-l border-zinc-800">
      {/* Header */}
      <div className="border-b border-zinc-800 px-4 py-2 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">Event Log</span>
        {events.length > 0 && (
          <span className="text-[10px] text-zinc-600">{events.length} events</span>
        )}
      </div>

      {/* Events */}
      <div className="flex-1 overflow-y-auto">
        {!sessionId ? (
          <p className="p-4 text-center text-xs text-zinc-600">
            Start a pipeline to see events here.
          </p>
        ) : events.length === 0 ? (
          <p className="p-4 text-center text-xs text-zinc-600 animate-pulse">
            Waiting for events…
          </p>
        ) : (
          events.map(e => <EventRow key={e.id} event={e} />)
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
