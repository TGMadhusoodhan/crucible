import { generateId } from '@/lib/utils'
import type {
  AlignmentMessage,
  ConversationActor,
  ConversationEvent,
  ConversationIndicator,
  PipelinePhase,
  Provider,
  Question,
  ReviewPayload,
  SelfCheckOutput,
  SpecDocument,
  ThinkingOutput,
} from '@/types'
import { appendSessionLog } from './filesystem'

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

export function logPhaseStart(
  projectId: string,
  sessionId: string,
  phase: PipelinePhase,
  label: string,
): Promise<void> {
  const event = makeEvent(sessionId, phase, 'system', 'progress', `Starting ${label}`, {
    type: 'phase_start',
  })
  return appendSessionLog(projectId, event)
}

// ─── Phase 1 — Thinking ───────────────────────────────────────────────────────

export function logThinkingDone(
  projectId: string,
  sessionId: string,
  actor: 'primary' | 'reviewer',
  output: ThinkingOutput,
): Promise<void> {
  const actorLabel = `${actor === 'primary' ? 'Primary' : 'Reviewer'} (${output.model_id})`
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
  return appendSessionLog(projectId, event)
}

// ─── Phase 1.5 — Alignment ────────────────────────────────────────────────────

export function logAlignmentMessage(
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
  return appendSessionLog(projectId, event)
}

export function logAlignmentConflict(
  projectId: string,
  sessionId: string,
  conflictDescription: string,
): Promise<void> {
  const event = makeEvent(sessionId, 'phase1_5_alignment', 'system', 'warning',
    `Architectural mismatch detected — surfaced as Phase 2 question`, {
    type:        'alignment_conflict',
    fullContent: conflictDescription,
  })
  return appendSessionLog(projectId, event)
}

// ─── Phase 2 — Questions ──────────────────────────────────────────────────────

export function logQuestionsReady(
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
  return appendSessionLog(projectId, event)
}

export function logUserAnswers(
  projectId: string,
  sessionId: string,
  answers: Record<string, string>,
  questions: Question[],
): Promise<void> {
  const answeredCount = Object.keys(answers).length
  const summary       = `Human answered ${answeredCount} question(s)`
  const fullContent   = Object.entries(answers)
    .map(([qId, optId]) => {
      const q   = questions.find(q => q.id === qId)
      const opt = q?.options.find(o => o.id === optId)
      return `• ${q?.text ?? qId}: ${opt?.label ?? optId}`
    })
    .join('\n')
  const event = makeEvent(sessionId, 'phase2_answering', 'human', 'user', summary, {
    type: 'user_answer',
    fullContent,
  })
  return appendSessionLog(projectId, event)
}

// ─── Phase 2 — Spec ───────────────────────────────────────────────────────────

export function logSpecWritten(
  projectId: string,
  sessionId: string,
  spec: SpecDocument,
): Promise<void> {
  const summary = `Spec written — ${spec.acceptance_criteria.length} criteria, ${spec.edge_cases.length} edge cases`
  const event   = makeEvent(sessionId, 'phase2_spec', 'system', 'progress', summary, {
    type:        'spec_written',
    fullContent: JSON.stringify(spec, null, 2),
  })
  return appendSessionLog(projectId, event)
}

export function logSpecConfirmed(
  projectId: string,
  sessionId: string,
): Promise<void> {
  const event = makeEvent(sessionId, 'phase2_spec_confirm', 'human', 'user',
    'Human confirmed the spec — proceeding to code generation', {
    type: 'spec_confirmed',
  })
  return appendSessionLog(projectId, event)
}

// ─── Phase 3 — Generation ────────────────────────────────────────────────────

export function logGenerationStart(
  projectId: string,
  sessionId: string,
  round: number,
  provider: Provider,
): Promise<void> {
  const event = makeEvent(sessionId, 'phase3_generating', provider, 'progress',
    `Generation started (round ${round})`, {
    type:  'generation_start',
    round,
  })
  return appendSessionLog(projectId, event)
}

export function logGenerationDone(
  projectId: string,
  sessionId: string,
  round: number,
  codeLength: number,
  tokensOut: number,
  costUsd: number,
  provider: Provider,
): Promise<void> {
  const event = makeEvent(sessionId, 'phase3_generating', provider, 'progress',
    `Code generated — ${codeLength} chars, ${tokensOut} tokens`, {
    type:     'generation_output',
    round,
    tokensOut,
    costUsd,
  })
  return appendSessionLog(projectId, event)
}

// ─── Phase 3 — Self-Check ─────────────────────────────────────────────────────

export function logSelfCheck(
  projectId: string,
  sessionId: string,
  output: SelfCheckOutput,
  costUsd: number,
  provider: Provider,
): Promise<void> {
  const summary = output.all_clear
    ? `Self-check pass ${output.pass} — all clear`
    : `Self-check pass ${output.pass} — ${output.issues.length} issue(s) found`
  const fullContent = [
    `Pass: ${output.pass}/2`,
    `All clear: ${output.all_clear}`,
    output.issues.length ? '\nIssues:' : '',
    ...output.issues.map(i => `  [${i.severity.toUpperCase()}] ${i.description}\n    Fix: ${i.suggested_fix}`),
    `\nReasoning: ${output.reasoning}`,
  ].filter(Boolean).join('\n')
  const event = makeEvent(sessionId, 'phase3_self_check', provider,
    output.all_clear ? 'success' : 'warning', summary, {
    type:        'self_check',
    round:       output.pass,
    fullContent,
    costUsd,
  })
  return appendSessionLog(projectId, event)
}

// ─── Phase 3 — Review ────────────────────────────────────────────────────────

export function logReview(
  projectId: string,
  sessionId: string,
  review: ReviewPayload,
  costUsd: number,
  provider: Provider,
): Promise<void> {
  const highMed  = review.flags.filter(f => f.severity !== 'LOW').length
  const low      = review.flags.filter(f => f.severity === 'LOW').length
  const summary  = review.consensus
    ? `Review round ${review.round} — consensus reached`
    : `Review round ${review.round} — ${highMed} HIGH/MEDIUM flag(s), ${low} LOW flag(s)`
  const fullContent = [
    `Consensus: ${review.consensus}`,
    `Round: ${review.round}`,
    review.flags.length ? '\nFlags:' : 'No flags.',
    ...review.flags.map(f =>
      `  [${f.severity}] [${f.category}] ${f.description}` +
      (f.pseudo_code_hint ? `\n    Hint: ${f.pseudo_code_hint}` : '') +
      (f.location ? ` (${f.location})` : '')
    ),
    `\nReasoning: ${review.reasoning}`,
  ].filter(Boolean).join('\n')
  const event = makeEvent(sessionId, 'phase3_reviewing',
    provider,
    review.consensus ? 'success' : 'warning',
    summary, {
    type:        'review_output',
    round:       review.round,
    fullContent,
    costUsd,
    isConsensus: review.consensus,
    isConflict:  !review.consensus,
  })
  return appendSessionLog(projectId, event)
}

export function logOutputPromoted(
  projectId: string,
  sessionId: string,
  checkpointId: string,
): Promise<void> {
  const event = makeEvent(sessionId, 'phase3_consensus', 'system', 'success',
    `Code promoted to output layer (checkpoint: ${checkpointId})`, {
    type:       'output_promoted',
    isConsensus: true,
  })
  return appendSessionLog(projectId, event)
}

// ─── Human override ───────────────────────────────────────────────────────────

export function logHumanOverride(
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
  return appendSessionLog(projectId, event)
}

export function logConflictEscalated(
  projectId: string,
  sessionId: string,
  round: number,
  reason: string,
): Promise<void> {
  const event = makeEvent(sessionId, 'conflict_escalated', 'system', 'error',
    `Conflict after round ${round} — human escalation required`, {
    type:        'conflict_escalated',
    round,
    fullContent: reason,
    isConflict:  true,
  })
  return appendSessionLog(projectId, event)
}

// ─── Pipeline controls ────────────────────────────────────────────────────────

export function logPause(projectId: string, sessionId: string, phase: PipelinePhase): Promise<void> {
  const event = makeEvent(sessionId, phase, 'human', 'user', 'Pipeline paused by human', { type: 'pause' })
  return appendSessionLog(projectId, event)
}

export function logPlay(projectId: string, sessionId: string, phase: PipelinePhase): Promise<void> {
  const event = makeEvent(sessionId, phase, 'human', 'user', 'Pipeline resumed', { type: 'play' })
  return appendSessionLog(projectId, event)
}

export function logStop(projectId: string, sessionId: string, phase: PipelinePhase): Promise<void> {
  const event = makeEvent(sessionId, phase, 'human', 'user', 'Pipeline stopped by human', { type: 'stop' })
  return appendSessionLog(projectId, event)
}

export function logBudgetModeChange(
  projectId: string,
  sessionId: string,
  phase: PipelinePhase,
  newMode: string,
): Promise<void> {
  const event = makeEvent(sessionId, phase, 'system', 'warning',
    `Budget mode changed to ${newMode}`, { type: 'budget_mode_change', fullContent: `New mode: ${newMode}` })
  return appendSessionLog(projectId, event)
}
