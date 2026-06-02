import { readRecentSessionLog, readFullSessionLog } from '@/lib/memory/filesystem'
import type {
  ConversationActor,
  ConversationEvent,
  ConversationEventType,
  ConversationIndicator,
  PipelinePhase,
} from '@/types'

// ─── Query options ────────────────────────────────────────────────────────────

export interface EventQueryOptions {
  phase?:     PipelinePhase
  type?:      ConversationEventType
  actor?:     ConversationActor
  indicator?: ConversationIndicator
  round?:     number
  since?:     string    // ISO8601 timestamp — return only events after this
  limit?:     number    // max events to return (most recent)
  expand?:    boolean   // if false, strip fullContent to reduce payload size
}

// ─── Phase group (for conversation tab timeline) ──────────────────────────────

export interface PhaseGroup {
  phase:      PipelinePhase
  label:      string
  events:     ConversationEvent[]
  startedAt:  string   // ISO8601 of first event
  endedAt?:   string   // ISO8601 of last event (undefined if still active)
  hasConflict: boolean
  hasConsensus: boolean
}

// ─── Session summary (for session header card) ────────────────────────────────

export interface SessionSummary {
  sessionId:     string
  totalEvents:   number
  totalTokensIn: number
  totalTokensOut:number
  totalCostUsd:  number
  phases:        PipelinePhase[]  // phases seen so far, in order
  hasConflict:   boolean
  isComplete:    boolean
  startedAt:     string
  lastActivityAt:string
}

// ─── Phase labels (mirrors phaseLabel in base.ts — kept local to avoid import) ─

const PHASE_LABELS: Partial<Record<PipelinePhase, string>> = {
  idle:                  'Idle',
  phase0_context:        'Phase 0: Context',
  phase1_thinking:       'Phase 1: Thinking',
  phase1_5_alignment:    'Phase 1.5: Alignment',
  phase2_questions:      'Phase 2: Questions',
  phase2_answering:      'Phase 2: Answering',
  phase2_contradictions: 'Phase 2: Contradictions',
  phase2_spec:           'Phase 2: Spec',
  phase2_spec_confirm:   'Phase 2: Spec Confirm',
  phase3_generating:     'Phase 3: Generating',
  phase3_self_check:     'Phase 3: Self-Check',
  phase3_reviewing:      'Phase 3: Review',
  phase3_consensus:      'Phase 3: Consensus',
  conflict_escalated:    'Conflict Escalated',
  complete:              'Complete',
  paused:                'Paused',
  stopped:               'Stopped',
  error:                 'Error',
}

function phaseLabel(phase: PipelinePhase): string {
  return PHASE_LABELS[phase] ?? phase
}

// ─── Core query ───────────────────────────────────────────────────────────────

/**
 * Returns filtered conversation events for a session.
 * Reads from the local session_log.jsonl (last 40k tokens by default).
 */
export async function getSessionEvents(
  projectId: string,
  opts:      EventQueryOptions = {},
): Promise<ConversationEvent[]> {
  const { phase, type, actor, indicator, round, since, limit, expand = false } = opts

  let events = await readRecentSessionLog(projectId)

  // ── Apply filters ──────────────────────────────────────────────────────────

  if (phase)     events = events.filter(e => e.phase === phase)
  if (type)      events = events.filter(e => e.type  === type)
  if (actor)     events = events.filter(e => e.actor === actor)
  if (indicator) events = events.filter(e => e.indicator === indicator)
  if (round !== undefined) events = events.filter(e => e.round === round)

  if (since) {
    const sinceTs = new Date(since).getTime()
    events = events.filter(e => new Date(e.timestamp).getTime() > sinceTs)
  }

  if (limit && limit > 0) {
    events = events.slice(-limit)
  }

  // ── Strip fullContent for initial loads (reduces payload, client loads on expand) ──

  if (!expand) {
    events = events.map(e => ({ ...e, fullContent: undefined }))
  }

  return events
}

/**
 * Returns the full content of a single event by ID.
 * Used when the client expands an event in the timeline.
 */
export async function getEventFullContent(
  projectId: string,
  eventId:   string,
): Promise<string | undefined> {
  const all = await readFullSessionLog(projectId)
  return all.find(e => e.id === eventId)?.fullContent
}

/**
 * Returns all events since `cursorTimestamp` — used for incremental polling.
 * Returns an empty array if nothing new has happened.
 */
export async function getEventsSince(
  projectId:       string,
  cursorTimestamp: string,
): Promise<ConversationEvent[]> {
  return getSessionEvents(projectId, { since: cursorTimestamp })
}

// ─── Phase timeline grouping ──────────────────────────────────────────────────

/**
 * Groups events into phase buckets for the conversation tab timeline.
 * Events within each phase are ordered chronologically.
 * Phases are ordered by first-seen timestamp.
 */
export async function getPhaseTimeline(projectId: string): Promise<PhaseGroup[]> {
  const events = await getSessionEvents(projectId, { expand: true })

  const phaseMap = new Map<PipelinePhase, ConversationEvent[]>()
  const phaseOrder: PipelinePhase[] = []

  for (const event of events) {
    if (!phaseMap.has(event.phase)) {
      phaseMap.set(event.phase, [])
      phaseOrder.push(event.phase)
    }
    phaseMap.get(event.phase)!.push(event)
  }

  return phaseOrder.map(phase => {
    const phaseEvents = phaseMap.get(phase)!
    const first = phaseEvents[0]!
    const last  = phaseEvents[phaseEvents.length - 1]!

    return {
      phase,
      label:        phaseLabel(phase),
      events:       phaseEvents,
      startedAt:    first.timestamp,
      endedAt:      last !== first ? last.timestamp : undefined,
      hasConflict:  phaseEvents.some(e => e.isConflict),
      hasConsensus: phaseEvents.some(e => e.isConsensus),
    }
  })
}

// ─── Session summary ──────────────────────────────────────────────────────────

/**
 * Returns high-level summary stats for a session.
 * Used by the session header card and the projects list.
 */
export async function getSessionSummary(projectId: string): Promise<SessionSummary | null> {
  const events = await readFullSessionLog(projectId)
  if (events.length === 0) return null

  const sessionId    = events[0]!.sessionId
  const totalTokensIn  = events.reduce((s, e) => s + (e.tokensIn  ?? 0), 0)
  const totalTokensOut = events.reduce((s, e) => s + (e.tokensOut ?? 0), 0)
  const totalCostUsd   = events.reduce((s, e) => s + (e.costUsd   ?? 0), 0)

  const seenPhases = new Set<PipelinePhase>()
  const phases: PipelinePhase[] = []
  for (const e of events) {
    if (!seenPhases.has(e.phase)) {
      seenPhases.add(e.phase)
      phases.push(e.phase)
    }
  }

  return {
    sessionId,
    totalEvents:    events.length,
    totalTokensIn,
    totalTokensOut,
    totalCostUsd,
    phases,
    hasConflict:   events.some(e => e.isConflict),
    isComplete:    events.some(e => e.type === 'output_promoted'),
    startedAt:     events[0]!.timestamp,
    lastActivityAt:events[events.length - 1]!.timestamp,
  }
}

// ─── SSE serialization ────────────────────────────────────────────────────────

/**
 * Formats a ConversationEvent as an SSE `data:` line.
 * The client's EventSource parses this back to JSON.
 */
export function serializeEventForSSE(event: ConversationEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/**
 * Formats a heartbeat SSE line — keeps the connection alive while
 * the pipeline is between phases and not emitting events.
 */
export function serializeHeartbeat(): string {
  return `: heartbeat ${Date.now()}\n\n`
}

// ─── Event filtering utilities (used by frontend components) ─────────────────

/** Returns only events that should show in the compact "activity" sidebar. */
export function filterActivityEvents(events: ConversationEvent[]): ConversationEvent[] {
  const ACTIVITY_TYPES: ConversationEventType[] = [
    'phase_start', 'model_output', 'question_generated', 'user_answer',
    'spec_written', 'spec_confirmed', 'generation_start', 'self_check',
    'review_output', 'output_promoted', 'conflict_escalated', 'human_override',
  ]
  return events.filter(e => ACTIVITY_TYPES.includes(e.type))
}

/** Returns only conflict/consensus events — used by the ConflictModal. */
export function filterConflictEvents(events: ConversationEvent[]): ConversationEvent[] {
  return events.filter(e => e.isConflict || e.isConsensus)
}

/** Returns only human-override events — used for override history display. */
export function filterOverrideEvents(events: ConversationEvent[]): ConversationEvent[] {
  return events.filter(e => e.isHumanOverride)
}

/** Groups review events by round number. */
export function groupReviewsByRound(
  events: ConversationEvent[],
): Map<number, ConversationEvent[]> {
  const map = new Map<number, ConversationEvent[]>()
  for (const e of events) {
    if (e.type === 'review_output' && e.round !== undefined) {
      if (!map.has(e.round)) map.set(e.round, [])
      map.get(e.round)!.push(e)
    }
  }
  return map
}
