import { generateId } from '@/lib/utils'
import type {
  AlignmentMessage,
  ConversationActor,
  ConversationEvent,
  ConversationIndicator,
  PipelinePhase,
  Provider,
  Question,
  ThinkingOutput,
} from '@/types'
import { appendSessionLog as writeSessionLogEvent } from './filesystem'

// ─── Event builder ────────────────────────────────────────────────────────────
// Every pipeline event that needs to appear in the conversation tab goes
// through one of these typed builders. They enforce the ConversationEvent
// shape so the timeline component can render every event correctly.

function makeEvent(
  sessionId: string,
  phase: PipelinePhase,
  actor: ConversationActor,
  indicator: ConversationIndicator,
  summary: string,
  opts: {
    type: ConversationEvent['type']
    round?: number
    fullContent?: string
    tokensIn?: number
    tokensOut?: number
    costUsd?: number
    isHumanOverride?: boolean
    isConflict?: boolean
    isConsensus?: boolean
  },
): ConversationEvent {
  return {
    id:             generateId(),
    sessionId,
    timestamp:      new Date().toISOString(),
    type:           opts.type,
    phase,
    round:          opts.round,
    actor,
    summary,
    fullContent:    opts.fullContent,
    tokensIn:       opts.tokensIn,
    tokensOut:      opts.tokensOut,
    costUsd:        opts.costUsd,
    indicator,
    isHumanOverride: opts.isHumanOverride,
    isConflict:     opts.isConflict,
    isConsensus:    opts.isConsensus,
    expandable:     !!opts.fullContent,
  }
}

// ─── Phase 0 ──────────────────────────────────────────────────────────────────

export async function logPhaseStart(
  projectId: string,
  sessionId: string,
  phase: PipelinePhase,
  label: string,
): Promise<void> {
  const event = makeEvent(sessionId, phase, 'system', 'progress', `Starting ${label}`, {
    type: 'phase_start',
  })
  writeSessionLogEvent(projectId, event)
}

// ─── Phase 1 — Thinking ───────────────────────────────────────────────────────

export async function logThinkingDone(
  projectId: string,
  sessionId: string,
  actor: 'r1' | 'r2',
  output: ThinkingOutput,
): Promise<void> {
  const actorLabel = `${actor === 'r1' ? 'R1' : 'R2'} (${output.model_id})`
  const summary    = `${actorLabel} thinking done — ${output.questions.length} question(s), ${output.assumptions.length} assumption(s)`
  const fullContent = [
    `Understood as: ${output.understood_as}`,
    '',
    `Approach: ${output.recommended_approach}`,
    '',
    output.risks.length ? `Risks: ${output.risks.join(', ')}` : '',
    '',
    `Questions (${output.questions.length}):`,
    ...output.questions.map((q, i) => `  ${i + 1}. [${q.category}] ${q.text}`),
  ].filter(Boolean).join('\n')

  const event = makeEvent(sessionId, 'phase1_thinking', output.provider, 'progress', summary, {
    type:        'model_output',
    tokensIn:    output.tokens_used,
    fullContent,
  })
  writeSessionLogEvent(projectId, event)
}

// ─── Phase 1.5 — Alignment ────────────────────────────────────────────────────

export async function logAlignmentMessage(
  projectId: string,
  sessionId: string,
  message: AlignmentMessage,
  primaryProvider: Provider,
  reviewerProvider: Provider,
): Promise<void> {
  const actorProvider: ConversationActor = message.actor === 'primary' ? primaryProvider : reviewerProvider
  const summary = `Round ${message.round} alignment — ${message.actor}: ${message.position.slice(0, 80)}${message.position.length > 80 ? '…' : ''}`
  const event   = makeEvent(sessionId, 'phase1_5_alignment', actorProvider, 'progress', summary, {
    type:        'alignment_message',
    round:       message.round,
    fullContent: [
      `understood_as: ${message.understood_as}`,
      `position: ${message.position}`,
      message.questions_summary.length
        ? `key questions: ${message.questions_summary.join('; ')}`
        : '',
    ].filter(Boolean).join('\n'),
  })
  writeSessionLogEvent(projectId, event)
}

export async function logAlignmentConflict(
  projectId: string,
  sessionId: string,
  conflictDescription: string,
): Promise<void> {
  const event = makeEvent(sessionId, 'phase1_5_alignment', 'system', 'warning',
    `Architectural mismatch detected — surfaced as Phase 2 question`, {
    type:        'alignment_conflict',
    fullContent: conflictDescription,
  })
  writeSessionLogEvent(projectId, event)
}

// ─── Phase 2 — Questions ──────────────────────────────────────────────────────

export async function logQuestionsReady(
  projectId: string,
  sessionId: string,
  questions: Question[],
): Promise<void> {
  const summary     = `${questions.length} question(s) ready for human`
  const fullContent = questions
    .map((q, i) => `${i + 1}. [${q.category}] ${q.text}\n   Options: ${q.options.map(o => o.label).join(' | ')}`)
    .join('\n\n')
  const event = makeEvent(sessionId, 'phase2_questions', 'system', 'progress', summary, {
    type: 'question_generated',
    fullContent,
  })
  writeSessionLogEvent(projectId, event)
}

// ─── Human override ───────────────────────────────────────────────────────────

export async function logHumanOverride(
  projectId: string,
  sessionId: string,
  phase: PipelinePhase,
  message: string,
): Promise<void> {
  const event = makeEvent(sessionId, phase, 'human', 'user',
    `Human override: ${message.slice(0, 60)}${message.length > 60 ? '…' : ''}`, {
    type:           'human_override',
    fullContent:    message,
    isHumanOverride: true,
  })
  writeSessionLogEvent(projectId, event)
}

// ─── Pipeline controls ────────────────────────────────────────────────────────

export async function logPause(projectId: string, sessionId: string, phase: PipelinePhase): Promise<void> {
  const event = makeEvent(sessionId, phase, 'human', 'user', 'Pipeline paused by human', { type: 'pause' })
  writeSessionLogEvent(projectId, event)
}

export async function logPlay(projectId: string, sessionId: string, phase: PipelinePhase): Promise<void> {
  const event = makeEvent(sessionId, phase, 'human', 'user', 'Pipeline resumed', { type: 'play' })
  writeSessionLogEvent(projectId, event)
}

export async function logStop(projectId: string, sessionId: string, phase: PipelinePhase): Promise<void> {
  const event = makeEvent(sessionId, phase, 'human', 'user', 'Pipeline stopped by human', { type: 'stop' })
  writeSessionLogEvent(projectId, event)
}

export async function logBudgetModeChange(
  projectId: string,
  sessionId: string,
  phase: PipelinePhase,
  newMode: string,
): Promise<void> {
  const event = makeEvent(sessionId, phase, 'system', 'warning',
    `Budget mode changed to ${newMode}`, { type: 'budget_mode_change', fullContent: `New mode: ${newMode}` })
  writeSessionLogEvent(projectId, event)
}

// ─── Phase 3 (V3) — per-file generate/review/cross-review/patch loop ─────────
// Simpler than the phase-specific logXxx() helpers above: these phases run
// once per file (not once per pipeline run), so a single generic entry point
// covers all of them instead of one bespoke function per call site.

function inferEventType(phase: PipelinePhase): ConversationEvent['type'] {
  if (phase === 'phase3_reviewing' || phase === 'phase3_cross_review') return 'review_output'
  return 'generation_output'
}

export async function appendSessionLog(
  projectId: string,
  sessionId: string,
  opts: {
    phase:   PipelinePhase
    actor:   ConversationActor
    round?:  number
    summary: string
  },
): Promise<void> {
  const event = makeEvent(sessionId, opts.phase, opts.actor, 'progress', opts.summary, {
    type:  inferEventType(opts.phase),
    round: opts.round,
  })
  writeSessionLogEvent(projectId, event)
}
