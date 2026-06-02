import { Redis } from '@upstash/redis'
import { getAdapter } from '@/lib/adapters'
import { getBudgetStatus, recordUsage } from '@/lib/budget'
import { logBudgetModeChange, logPause, logPlay, logStop } from '@/lib/memory/session-log'
import { capturePipelineError } from '@/lib/sentry'
import { generateId } from '@/lib/utils'
import { estimateTokens } from '@/lib/utils/tokens'
import { runPhase0Context }        from './phase0-context'
import { runPhase1Thinking }       from './phase1-thinking'
import { runPhase1_5Alignment }    from './phase1-5-alignment'
import { runPhase2Questions }      from './phase2-questions'
import { detectContradictions }    from './phase2-contradiction'
import { runPhase2Spec }           from './phase2-spec'
import { runPhase3Generate }       from './phase3-generate'
import { runPhase3Review }         from './phase3-review'
import { runPhase3Consensus, promoteAfterHumanResolution } from './phase3-consensus'
import { consumePendingOverrides } from './human-override'
import type {
  BudgetMode,
  ContextInput,
  PipelineConfig,
  PipelinePhase,
  PipelineSessionState,
  ReviewPayload,
  SSEEvent,
} from '@/types'

// ─── Redis key helpers ────────────────────────────────────────────────────────

const STATE_KEY   = (sid: string) => `pipeline:${sid}:state`
const EVENTS_KEY  = (sid: string) => `pipeline:${sid}:events`
const CONTROL_KEY = (sid: string) => `pipeline:${sid}:control`

const SESSION_TTL = 60 * 60 * 24  // 24 hours

function getRedis(): Redis {
  return new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  })
}

// ─── Session state — Redis CRUD ───────────────────────────────────────────────

export async function getSessionState(sessionId: string): Promise<PipelineSessionState | null> {
  const redis = getRedis()
  const raw   = await redis.get<string>(STATE_KEY(sessionId))
  if (!raw) return null
  try {
    return typeof raw === 'string' ? JSON.parse(raw) as PipelineSessionState : raw as PipelineSessionState
  } catch {
    return null
  }
}

export async function saveSessionState(state: PipelineSessionState): Promise<void> {
  const redis = getRedis()
  state.updatedAt = Date.now()
  await redis.setex(STATE_KEY(state.sessionId), SESSION_TTL, JSON.stringify(state))
}

// ─── SSE event queue ─────────────────────────────────────────────────────────

export async function publishEvent(sessionId: string, event: SSEEvent): Promise<void> {
  const redis = getRedis()
  await redis.rpush(EVENTS_KEY(sessionId), JSON.stringify(event))
  await redis.expire(EVENTS_KEY(sessionId), SESSION_TTL)
}

/**
 * Consume all queued SSE events for a session — used by the SSE stream route.
 * LMPOP atomically removes and returns up to `count` events from the head.
 */
export async function consumeEvents(sessionId: string, count = 50): Promise<SSEEvent[]> {
  const redis = getRedis()
  // Upstash supports LPOP with count argument
  const raw = await redis.lpop<string>(EVENTS_KEY(sessionId), count)
  if (!raw) return []
  const items = Array.isArray(raw) ? raw : [raw]
  return items.flatMap(item => {
    try {
      return [JSON.parse(item) as SSEEvent]
    } catch {
      return []
    }
  })
}

// ─── Control signals — pause / stop ──────────────────────────────────────────

export async function setControlSignal(
  sessionId: string,
  signal: 'pause' | 'stop' | null,
): Promise<void> {
  const redis = getRedis()
  if (signal === null) {
    await redis.del(CONTROL_KEY(sessionId))
  } else {
    await redis.setex(CONTROL_KEY(sessionId), SESSION_TTL, signal)
  }
}

export async function getControlSignal(sessionId: string): Promise<'pause' | 'stop' | null> {
  const redis = getRedis()
  const val   = await redis.get<string>(CONTROL_KEY(sessionId))
  if (val === 'pause' || val === 'stop') return val
  return null
}

// ─── Pipeline session factory ─────────────────────────────────────────────────

export interface StartPipelineParams {
  userId:          string           // Clerk user ID — required for budget tracking
  projectId:       string
  taskDescription: string
  config:          PipelineConfig
  contextInput?:   ContextInput
  budgetMode?:     BudgetMode
}

export async function createSession(params: StartPipelineParams): Promise<string> {
  const sessionId = generateId()
  const { contextText } = params.contextInput
    ? runPhase0Context(params.contextInput)
    : { contextText: '' }

  const state: PipelineSessionState = {
    sessionId,
    projectId:           params.projectId,
    userId:              params.userId,
    phase:               'phase1_thinking',
    config:              params.config,
    round:               1,
    selfCheckPass:       0,
    taskDescription:     params.taskDescription,
    contextText:         contextText || undefined,
    pendingHumanOverrides: [],
    conversationHistory: [],
    budgetMode:          params.budgetMode ?? 'FULL',
    createdAt:           Date.now(),
    updatedAt:           Date.now(),
  }

  await saveSessionState(state)
  return sessionId
}

// ─── Public control API ───────────────────────────────────────────────────────

export async function pauseSession(sessionId: string): Promise<void> {
  await setControlSignal(sessionId, 'pause')
  const state = await getSessionState(sessionId)
  if (!state) return
  await logPause(state.projectId, sessionId, state.phase)
  state.phase = 'paused'
  await saveSessionState(state)
}

export async function playSession(sessionId: string): Promise<void> {
  await setControlSignal(sessionId, null)
  const state = await getSessionState(sessionId)
  if (!state) return
  await logPlay(state.projectId, sessionId, state.phase)
  // Resume from wherever we left off — caller will invoke runPipeline()
}

export async function stopSession(sessionId: string): Promise<void> {
  await setControlSignal(sessionId, 'stop')
  const state = await getSessionState(sessionId)
  if (!state) return
  await logStop(state.projectId, sessionId, state.phase)
  state.phase = 'stopped'
  await saveSessionState(state)
}

export async function injectOverride(sessionId: string, message: string): Promise<void> {
  const state = await getSessionState(sessionId)
  if (!state) throw new Error(`Session not found: ${sessionId}`)
  state.pendingHumanOverrides.push(message)
  await saveSessionState(state)
}

export async function submitAnswers(
  sessionId: string,
  answers: Record<string, string>,
): Promise<void> {
  const state = await getSessionState(sessionId)
  if (!state) throw new Error(`Session not found: ${sessionId}`)
  if (state.phase !== 'phase2_answering') {
    throw new Error(`Session is not waiting for answers (current phase: ${state.phase})`)
  }
  state.userAnswers = answers
  state.phase = 'phase2_contradictions'
  await saveSessionState(state)
}

export async function confirmSpec(sessionId: string): Promise<void> {
  const state = await getSessionState(sessionId)
  if (!state) throw new Error(`Session not found: ${sessionId}`)
  if (state.phase !== 'phase2_spec_confirm') {
    throw new Error(`Session is not waiting for spec confirmation (current phase: ${state.phase})`)
  }
  if (state.spec) {
    state.spec.human_confirmed = true
    state.spec.confirmed_at    = new Date().toISOString()
  }
  state.phase = 'phase3_generating'
  await saveSessionState(state)
}

export async function resolveConflict(
  sessionId: string,
  overrideMessage: string,
): Promise<void> {
  const state = await getSessionState(sessionId)
  if (!state) throw new Error(`Session not found: ${sessionId}`)
  if (state.phase !== 'conflict_escalated') {
    throw new Error(`Session is not in conflict_escalated phase (current: ${state.phase})`)
  }
  state.pendingHumanOverrides.push(overrideMessage)
  state.phase = 'phase3_generating'
  state.round = 1  // Reset round — human decision anchors both models
  await saveSessionState(state)
}

// ─── Alignment skip heuristic ─────────────────────────────────────────────────
// Skip the 2-round alignment API calls when thinking outputs already show agreement.
// The reviewer's code-review is the real quality gate — alignment is pre-flight
// conflict detection only.

import type { ThinkingOutput } from '@/types'

function canSkipAlignment(primary: ThinkingOutput, reviewer: ThinkingOutput): boolean {
  if (primary.understood_as === 'Model returned unparseable output') return false
  if (reviewer.understood_as === 'Model returned unparseable output') return false
  // If models raised 3+ required questions across both outputs, there's genuine
  // architectural ambiguity that benefits from alignment
  const reqCount = [...primary.questions, ...reviewer.questions].filter(q => q.is_required).length
  if (reqCount > 2) return false
  return true
}

// ─── Check control signal between phases ─────────────────────────────────────

async function checkControl(
  sessionId: string,
): Promise<'pause' | 'stop' | 'continue'> {
  const signal = await getControlSignal(sessionId)
  return signal ?? 'continue'
}

// ─── Emit helper ─────────────────────────────────────────────────────────────
// Always publishes to Redis (for state persistence + pause/stop detection).
// If externalEmit is provided (SSE stream path), also calls it directly for
// zero-latency delivery without polling.

function makeEmit(
  sessionId:     string,
  externalEmit?: (event: SSEEvent) => void,
): (event: SSEEvent) => void {
  return (event: SSEEvent) => {
    publishEvent(sessionId, event).catch(err =>
      console.error(`[orchestrator] publishEvent failed for ${sessionId}:`, err)
    )
    externalEmit?.(event)
  }
}

// ─── Budget recording (fully fire-and-forget) ────────────────────────────────
// Never await budget operations — they must never block the pipeline between phases.

function recordAndRefreshBudget(
  state:    PipelineSessionState,
  provider: typeof state.config.primaryProvider,
  modelId:  string,
  tokensIn: number,
  tokensOut:number,
  emit:     (event: SSEEvent) => void,
): void {
  recordUsage(state.userId, state.sessionId, provider, modelId, tokensIn, tokensOut)
    .catch(err => console.error('[budget] recordUsage failed:', err))

  // Refresh budget mode asynchronously — never awaited
  getBudgetStatus(state.userId, state.sessionId)
    .then(budget => {
      if (budget.mode !== state.budgetMode) {
        state.budgetMode = budget.mode
        logBudgetModeChange(state.projectId, state.sessionId, state.phase, budget.mode).catch(() => {})
        emit({ type: 'phase_change', phase: state.phase })
      }
    })
    .catch(() => { /* non-fatal */ })
}

// ─── Transition helper ────────────────────────────────────────────────────────

async function transition(
  state: PipelineSessionState,
  phase: PipelinePhase,
): Promise<PipelineSessionState> {
  state.phase = phase
  await saveSessionState(state)
  return state
}

// ─── Main pipeline runner (resumable state machine) ──────────────────────────

/**
 * Runs the pipeline from wherever the session state left off.
 *
 * This function is re-entrant: it reads the current phase from Redis and
 * picks up execution from there. It returns when:
 *   - It reaches a human-input gate (questions, spec confirm, conflict)
 *   - The pipeline completes or is stopped
 *   - An error occurs
 *
 * Phases that wait for human input:
 *   phase2_answering    → returns; caller resumes via submitAnswers() + runPipeline()
 *   phase2_spec_confirm → returns; caller resumes via confirmSpec() + runPipeline()
 *   conflict_escalated  → returns; caller resumes via resolveConflict() + runPipeline()
 */
export async function runPipeline(
  sessionId:     string,
  externalEmit?: (event: SSEEvent) => void,
): Promise<void> {
  let state = await getSessionState(sessionId)
  if (!state) throw new Error(`Session not found: ${sessionId}`)

  const emit      = makeEmit(sessionId, externalEmit)
  const projectId = state.projectId
  const { config } = state

  const primary  = getAdapter(config.primaryProvider,  config.primaryModelId,  config.primaryApiKey)
  const reviewer = getAdapter(config.reviewerProvider, config.reviewerModelId, config.reviewerApiKey)

  // ─── Helper: check control signal between every phase ──────────────────────

  const maybeStop = async (): Promise<boolean> => {
    const signal = await checkControl(sessionId)
    if (signal === 'stop') {
      emit({ type: 'done' })
      return true
    }
    if (signal === 'pause') {
      state = await transition(state!, 'paused')
      return true
    }
    return false
  }

  // ─── Phase 1: Thinking ─────────────────────────────────────────────────────

  if (state.phase === 'phase1_thinking') {
    if (await maybeStop()) return

    try {
      const result = await runPhase1Thinking(
        projectId, sessionId, state.taskDescription,
        primary, reviewer, emit, state.contextText,
      )
      state.thinkingOutputs = result
      // Record budget for both models' thinking calls
      const taskTokens = estimateTokens(state.taskDescription)
      recordAndRefreshBudget(state, config.primaryProvider, config.primaryModelId,
        taskTokens, result.primary.tokens_used, emit)
      recordAndRefreshBudget(state, config.reviewerProvider, config.reviewerModelId,
        taskTokens, result.reviewer.tokens_used, emit)
      state = await transition(state, 'phase1_5_alignment')
    } catch (err) {
      await handleError(state, err, emit)
      return
    }
  }

  // ─── Phase 1.5: Alignment ─────────────────────────────────────────────────

  if (state.phase === 'phase1_5_alignment') {
    if (await maybeStop()) return

    try {
      const { primary: pThink, reviewer: rThink } = state.thinkingOutputs!

      if (canSkipAlignment(pThink, rThink)) {
        // Fast path: merge thinking outputs directly — no model API calls.
        // Saves 20-60s. Genuine conflicts surface during reviewer code review.
        state.alignmentResult = {
          messages: [],
          agreed_questions:              [...pThink.questions, ...rThink.questions],
          agreed_recommendations:        [pThink.recommended_approach].filter(Boolean),
          unresolved_conflicts:          [],
          architectural_mismatch_detected: false,
          rounds_taken:                  1,
          total_tokens:                  0,
        }
      } else {
        // Full alignment — needed when models raised 3+ required questions
        const result = await runPhase1_5Alignment(
          projectId, sessionId, state.taskDescription,
          pThink, rThink, primary, reviewer, emit, state.contextText,
        )
        state.alignmentResult = result
      }
      state = await transition(state, 'phase2_questions')
    } catch (err) {
      await handleError(state, err, emit)
      return
    }
  }

  // ─── Phase 2: Questions ───────────────────────────────────────────────────

  if (state.phase === 'phase2_questions') {
    if (await maybeStop()) return

    try {
      const questions = await runPhase2Questions(
        projectId, sessionId,
        state.thinkingOutputs!.primary,
        state.thinkingOutputs!.reviewer,
        state.alignmentResult!,
        emit,
      )
      state.questions = questions

      // Auto-select recommended options for non-required questions.
      // This reduces Q&A friction — users only answer questions where the
      // model had no clear recommendation or the question is architecturally required.
      const autoAnswers: Record<string, string> = { ...(state.userAnswers ?? {}) }
      for (const q of questions) {
        if (!q.is_required && q.recommended_option_id && !autoAnswers[q.id]) {
          autoAnswers[q.id] = q.recommended_option_id
        }
      }
      state.userAnswers = autoAnswers

      const hasUnansweredRequired = questions.some(q => q.is_required && !autoAnswers[q.id])
      if (hasUnansweredRequired) {
        state = await transition(state, 'phase2_answering')
        return  // ← Human input gate: wait for required answers only
      }
      // All questions resolved — skip Q&A gate entirely
      state = await transition(state, 'phase2_contradictions')
      // falls through to phase2_contradictions block below
    } catch (err) {
      await handleError(state, err, emit)
      return
    }
  }

  // ─── Gate: waiting for answers ────────────────────────────────────────────

  if (state.phase === 'phase2_answering') return

  // ─── Phase 2: Contradiction detection ────────────────────────────────────

  if (state.phase === 'phase2_contradictions') {
    if (await maybeStop()) return

    const contradictions = detectContradictions(state.questions!, state.userAnswers!)
    state.contradictions = contradictions

    // Emit all contradictions so the UI can surface them — but do NOT block.
    // Contradictions become edge cases in the spec, and the human resolves
    // any genuine conflict when they review and confirm the spec.
    for (const c of contradictions) {
      emit({ type: 'contradiction', contradiction: c })
    }

    state = await transition(state, 'phase2_spec')
    // falls through to phase2_spec block below
  }

  // ─── Phase 2: Spec generation ─────────────────────────────────────────────

  if (state.phase === 'phase2_spec') {
    if (await maybeStop()) return

    try {
      const spec = await runPhase2Spec({
        projectId,
        sessionId,
        taskDescription: state.taskDescription,
        questions:       state.questions!,
        userAnswers:     state.userAnswers!,
        thinkingOutputs: state.thinkingOutputs!,
        contradictions:  state.contradictions,
        contextText:     state.contextText,
      }, emit)

      state.spec = spec
      state = await transition(state, 'phase2_spec_confirm')
      return  // ← Human input gate: wait for spec confirmation via confirmSpec()
    } catch (err) {
      await handleError(state, err, emit)
      return
    }
  }

  // ─── Gate: waiting for spec confirmation ─────────────────────────────────

  if (state.phase === 'phase2_spec_confirm') return

  // ─── Phase 3 loop: Generate → Self-Check → Review → Consensus ────────────

  while (
    state.phase === 'phase3_generating' ||
    state.phase === 'phase3_reviewing'  ||
    state.phase === 'phase3_consensus'  ||
    state.phase === 'phase3_self_check'
  ) {
    if (await maybeStop()) return

    // Inject any pending human overrides into the context for this round
    const overrideText = consumePendingOverrides(state.pendingHumanOverrides)
    state.pendingHumanOverrides = []

    const ctx = buildContext(state, overrideText)

    // ── Generate ────────────────────────────────────────────────────────────

    let code: string
    try {
      const genResult = await runPhase3Generate(
        projectId, sessionId, state.round, ctx, primary, emit,
        state.lastReview && !state.lastReview.consensus ? state.lastReview : undefined,
        state.generatedCode,  // the code from the previous round — used in patch mode
      )
      code                  = genResult.code
      state.generatedCode   = code
      state.selfCheckOutput = genResult.selfCheckOutput
      recordAndRefreshBudget(state, config.primaryProvider, config.primaryModelId,
        estimateTokens(ctx.taskDescription), genResult.tokensOut, emit)
      state = await transition(state, 'phase3_reviewing')
    } catch (err) {
      await handleError(state, err, emit)
      return
    }

    if (await maybeStop()) return

    // ── Review ───────────────────────────────────────────────────────────────

    let review: ReviewPayload
    try {
      review = await runPhase3Review(
        projectId, sessionId, code, ctx, reviewer,
        state.round, emit, state.lastReview,
      )
      state.lastReview = review

      // Append this round's exchange to conversation history so both models have
      // full context in subsequent rounds (summary of code + reviewer reasoning).
      const now = Date.now()
      state.conversationHistory = [
        ...state.conversationHistory,
        {
          role:      'assistant' as const,
          content:   `[Round ${state.round} generated code — ${code.length} chars]`,
          timestamp: now,
        },
        {
          role:      'user' as const,
          content:   `[Round ${state.round} reviewer feedback] ${review.reasoning} Flags: ${
            review.flags.map(f => `[${f.severity}] ${f.description}`).join(' | ')
          }`,
          timestamp: now,
        },
      ]

      recordAndRefreshBudget(state, config.reviewerProvider, config.reviewerModelId,
        estimateTokens(code), estimateTokens(JSON.stringify(review)), emit)
      state = await transition(state, 'phase3_consensus')
    } catch (err) {
      await handleError(state, err, emit)
      return
    }

    if (await maybeStop()) return

    // ── Consensus ────────────────────────────────────────────────────────────

    let decision: Awaited<ReturnType<typeof runPhase3Consensus>>
    try {
      decision = await runPhase3Consensus(
        projectId, sessionId, code, review, ctx, emit,
      )
    } catch (err) {
      await handleError(state, err, emit)
      return
    }

    if (decision.promote) {
      state.output = decision.output
      state = await transition(state, 'complete')
      return
    }

    if (decision.escalate) {
      state = await transition(state, 'conflict_escalated')
      return  // ← Human input gate: wait for resolveConflict()
    }

    // No consensus, no escalation → increment round and retry
    state.round += 1
    state = await transition(state, 'phase3_generating')
  }

  // ─── Gate: waiting for conflict resolution ────────────────────────────────

  if (state.phase === 'conflict_escalated') return
}

// ─── Human conflict resolution (called after resolveConflict()) ──────────────

export async function resumeAfterConflictResolution(sessionId: string): Promise<void> {
  const state = await getSessionState(sessionId)
  if (!state || !state.generatedCode || !state.lastReview) return

  const emit = makeEmit(sessionId)
  await promoteAfterHumanResolution(
    state.projectId, sessionId,
    state.generatedCode, state.lastReview, emit,
  )

  state.phase = 'complete'
  await saveSessionState(state)
}

// ─── Error handler ────────────────────────────────────────────────────────────

async function handleError(
  state: PipelineSessionState,
  err:   unknown,
  emit:  (event: SSEEvent) => void,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[orchestrator] Error in phase ${state.phase}:`, message)

  // Report to Sentry with full pipeline context
  capturePipelineError(err, {
    sessionId: state.sessionId,
    projectId: state.projectId,
    userId:    state.userId,
    phase:     state.phase,
    round:     state.round,
  })

  state.phase = 'error'
  await saveSessionState(state)

  emit({ type: 'error', message, phase: state.phase })
  emit({ type: 'done' })
}

// ─── Context builder ─────────────────────────────────────────────────────────

function buildContext(
  state:        PipelineSessionState,
  overrideText: string | null,
) {
  const base = {
    projectId:       state.projectId,
    sessionId:       state.sessionId,
    spec:            state.spec!,
    history:         state.conversationHistory,
    activeMemory:    {
      current_module:       state.taskDescription.slice(0, 80),
      open_questions:       [],
      file_structure:       {},
      recent_decisions:     [],
      current_tech_stack:   [],
      unresolved_conflicts: [],
    },
    contextText:     state.contextText,
    humanOverrides:  overrideText ? [overrideText] : [],
    taskDescription: state.taskDescription,
  }

  return base
}

// ─── Utility: get session for API routes ─────────────────────────────────────

export { getAdapter }

export type { PipelineSessionState, PipelineConfig }
