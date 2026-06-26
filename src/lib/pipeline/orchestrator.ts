import fs   from 'fs'
import path from 'path'
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
import { runPhase3ReviewerEdit }   from './phase3-reviewer-edit'
import { runPhase3CoderVerify }    from './phase3-coder-verify'
import { runPhase3Dialogue }       from './phase3-dialogue'
import { runPhase3Consensus }      from './phase3-consensus'
import { consumePendingOverrides } from './human-override'
import type {
  BudgetMode,
  ConsensusOutput,
  ContextInput,
  CoderVerification,
  DialogueSummary,
  PipelineConfig,
  PipelinePhase,
  PipelineSessionState,
  ReviewEdit,
  ReviewPayload,
  SpecDocument,
  SSEEvent,
  ThinkingOutput,
} from '@/types'

// ─── In-memory stores (global singleton — survives Next.js hot reload) ────────

declare global {
  var __sessionStore:  Map<string, PipelineSessionState> | undefined
  var __controlStore:  Map<string, 'pause' | 'stop'>    | undefined
}

const sessionStore: Map<string, PipelineSessionState> =
  global.__sessionStore ??= new Map()

const controlStore: Map<string, 'pause' | 'stop'> =
  global.__controlStore ??= new Map()

// ─── Session state CRUD ───────────────────────────────────────────────────────

export async function getSessionState(sessionId: string): Promise<PipelineSessionState | null> {
  return sessionStore.get(sessionId) ?? null
}

export async function saveSessionState(state: PipelineSessionState): Promise<void> {
  state.updatedAt = Date.now()
  sessionStore.set(state.sessionId, state)
}

// ─── Project output (filesystem — survives restarts + Docker volume) ──────────

const getDataDir = () => process.env.DATA_DIR ?? './data'

export interface StoredProjectOutput {
  output:    ConsensusOutput
  spec:      SpecDocument | null
  savedAt:   number
  sessionId: string
}

export async function saveProjectOutput(
  _userId:   string,
  projectId: string,
  output:    ConsensusOutput,
  spec:      SpecDocument | null,
  sessionId: string,
): Promise<void> {
  const dir  = path.join(getDataDir(), 'projects', projectId)
  fs.mkdirSync(dir, { recursive: true })
  const stored: StoredProjectOutput = { output, spec, savedAt: Date.now(), sessionId }
  fs.writeFileSync(path.join(dir, 'output.json'), JSON.stringify(stored, null, 2))
}

export async function getProjectOutput(
  _userId:   string,
  projectId: string,
): Promise<StoredProjectOutput | null> {
  const file = path.join(getDataDir(), 'projects', projectId, 'output.json')
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8')) as StoredProjectOutput
  } catch {
    return null
  }
}

// ─── Control signals (pause / stop) ──────────────────────────────────────────

export async function setControlSignal(
  sessionId: string,
  signal: 'pause' | 'stop' | null,
): Promise<void> {
  if (signal === null) controlStore.delete(sessionId)
  else controlStore.set(sessionId, signal)
}

export async function getControlSignal(sessionId: string): Promise<'pause' | 'stop' | null> {
  return controlStore.get(sessionId) ?? null
}

// ─── Pipeline session factory ─────────────────────────────────────────────────

export interface StartPipelineParams {
  userId:          string
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
  state.previousPhase = state.phase
  state.phase = 'paused'
  await saveSessionState(state)
}

export async function playSession(sessionId: string): Promise<void> {
  await setControlSignal(sessionId, null)
  const state = await getSessionState(sessionId)
  if (!state) return
  await logPlay(state.projectId, sessionId, state.phase)
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
  state.round = 1
  state.lastReview = undefined
  await saveSessionState(state)
}

// ─── Alignment skip heuristic ─────────────────────────────────────────────────

function canSkipAlignment(primary: ThinkingOutput, reviewer: ThinkingOutput): boolean {
  if (primary.understood_as === 'Model returned unparseable output') return false
  if (reviewer.understood_as === 'Model returned unparseable output') return false
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

function makeEmit(
  sessionId:     string,
  externalEmit?: (event: SSEEvent) => void,
): (event: SSEEvent) => void {
  void sessionId
  return (event: SSEEvent) => {
    externalEmit?.(event)
  }
}

// ─── Budget recording (fully fire-and-forget) ────────────────────────────────

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

  getBudgetStatus(state.userId, state.sessionId)
    .then(budget => {
      if (budget.mode !== state.budgetMode) {
        state.budgetMode = budget.mode
        saveSessionState(state).catch(() => {})
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

export async function runPipeline(
  sessionId:     string,
  externalEmit?: (event: SSEEvent) => void,
): Promise<void> {
  let state = await getSessionState(sessionId)
  if (!state) throw new Error(`Session not found: ${sessionId}`)

  if (state.phase === 'paused') {
    const resumePhase = state.previousPhase ?? 'phase3_generating'
    state.previousPhase = undefined
    state = await transition(state, resumePhase)
  }

  const emit      = makeEmit(sessionId, externalEmit)
  const projectId = state.projectId
  const { config } = state

  const primary  = getAdapter(config.primaryProvider,  config.primaryModelId,  config.primaryApiKey)
  const reviewer = getAdapter(config.reviewerProvider, config.reviewerModelId, config.reviewerApiKey)

  const maybeStop = async (): Promise<boolean> => {
    const signal = await checkControl(sessionId)
    if (signal === 'stop') {
      emit({ type: 'done' })
      return true
    }
    if (signal === 'pause') {
      state!.previousPhase = state!.phase
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
        return
      }
      state = await transition(state, 'phase2_contradictions')
    } catch (err) {
      await handleError(state, err, emit)
      return
    }
  }

  if (state.phase === 'phase2_answering') return

  // ─── Phase 2: Contradiction detection ────────────────────────────────────

  if (state.phase === 'phase2_contradictions') {
    if (await maybeStop()) return

    const contradictions = detectContradictions(state.questions!, state.userAnswers!)
    state.contradictions = contradictions

    for (const c of contradictions) {
      emit({ type: 'contradiction', contradiction: c })
    }

    state = await transition(state, 'phase2_spec')
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
      return
    } catch (err) {
      await handleError(state, err, emit)
      return
    }
  }

  if (state.phase === 'phase2_spec_confirm') return

  // ─── Phase 3 loop: Generate → Review → ReviewerEdit → CoderVerify → Dialogue ─

  while (
    state.phase === 'phase3_generating'    ||
    state.phase === 'phase3_self_check'    ||
    state.phase === 'phase3_reviewing'     ||
    state.phase === 'phase3_reviewer_edit' ||
    state.phase === 'phase3_coder_verify'  ||
    state.phase === 'phase3_dialogue'      ||
    state.phase === 'phase3_consensus'
  ) {
    if (await maybeStop()) return

    const overrideText = consumePendingOverrides(state.pendingHumanOverrides)
    state.pendingHumanOverrides = []
    const ctx = buildContext(state, overrideText)

    // ── Generate + Self-Check ────────────────────────────────────────────────

    if (state.phase === 'phase3_generating' || state.phase === 'phase3_self_check') {
      try {
        const genResult = await runPhase3Generate(
          projectId, sessionId, state.round, ctx, primary, emit,
          undefined,
          state.generatedCode,
        )
        state.generatedCode      = genResult.code
        state.generatedFiles     = genResult.files
        state.selfCheckOutput    = genResult.selfCheckOutput
        state.reviewerEdit       = undefined
        state.mergedCode         = undefined
        state.coderVerification  = undefined
        state.dialogue           = undefined

        const genPromptTokens = estimateTokens(ctx.taskDescription)
          + estimateTokens(JSON.stringify(ctx.spec))
          + estimateTokens(ctx.history.map(m => m.content).join(' '))
        recordAndRefreshBudget(state, config.primaryProvider, config.primaryModelId,
          genPromptTokens, genResult.tokensOut, emit)
        state = await transition(state, 'phase3_reviewing')
        return
      } catch (err) {
        await handleError(state, err, emit)
        return
      }
    }

    if (await maybeStop()) return

    // ── Review ───────────────────────────────────────────────────────────────

    if (state.phase === 'phase3_reviewing') {
      const code = state.generatedCode!
      let review: ReviewPayload
      try {
        review = await runPhase3Review(
          projectId, sessionId, code, ctx, reviewer,
          state.round, emit, state.lastReview,
        )
        state.lastReview = review

        const now = Date.now()
        state.conversationHistory = [
          ...state.conversationHistory,
          { role: 'assistant' as const, content: `[Round ${state.round} code — ${code.length} chars]`, timestamp: now },
          {
            role: 'user' as const,
            content: `[Round ${state.round} review] ${review.reasoning} Flags: ${
              review.flags.map(f => `[${f.severity}] ${f.description}`).join(' | ')
            }`,
            timestamp: now,
          },
        ]

        const reviewPromptTokens = estimateTokens(code) + estimateTokens(JSON.stringify(ctx.spec))
        recordAndRefreshBudget(state, config.reviewerProvider, config.reviewerModelId,
          reviewPromptTokens, estimateTokens(JSON.stringify(review)), emit)

        if (review.consensus) {
          state = await transition(state, 'phase3_consensus')
        } else {
          state = await transition(state, 'phase3_reviewer_edit')
        }
      } catch (err) {
        await handleError(state, err, emit)
        return
      }
    }

    if (await maybeStop()) return

    // ── Reviewer Edit ─────────────────────────────────────────────────────────

    if (state.phase === 'phase3_reviewer_edit') {
      const code   = state.generatedCode!
      const review = state.lastReview!
      try {
        const { edit, mergedCode } = await runPhase3ReviewerEdit(
          projectId, sessionId, code, review, ctx, reviewer, state.round, emit,
        )
        state.reviewerEdit = edit
        state.mergedCode   = mergedCode
        state = await transition(state, 'phase3_coder_verify')
      } catch (err) {
        await handleError(state, err, emit)
        return
      }
    }

    if (await maybeStop()) return

    // ── Coder Verify ──────────────────────────────────────────────────────────

    if (state.phase === 'phase3_coder_verify') {
      const code       = state.generatedCode!
      const edit       = state.reviewerEdit!
      const mergedCode = state.mergedCode!
      const review     = state.lastReview!
      try {
        const verification = await runPhase3CoderVerify(
          projectId, sessionId, code, edit, mergedCode, review, ctx, primary, state.round, emit,
        )
        state.coderVerification = verification

        if (verification.agrees) {
          state.generatedCode = mergedCode
          state = await transition(state, 'phase3_consensus')
        } else {
          state = await transition(state, 'phase3_dialogue')
        }
      } catch (err) {
        await handleError(state, err, emit)
        return
      }
    }

    if (await maybeStop()) return

    // ── Model Dialogue ────────────────────────────────────────────────────────

    if (state.phase === 'phase3_dialogue') {
      const code         = state.generatedCode!
      const mergedCode   = state.mergedCode!
      const edit         = state.reviewerEdit!
      const verification = state.coderVerification!
      const review       = state.lastReview!
      try {
        const dialogue = await runPhase3Dialogue(
          projectId, sessionId, code, mergedCode, edit, verification,
          review, ctx, primary, reviewer, state.round, emit,
        )
        state.dialogue = dialogue

        if (dialogue.resolved) {
          state.generatedCode = mergedCode
          state = await transition(state, 'phase3_consensus')
        } else {
          state = await transition(state, 'conflict_escalated')
          return
        }
      } catch (err) {
        await handleError(state, err, emit)
        return
      }
    }

    if (await maybeStop()) return

    // ── Consensus ─────────────────────────────────────────────────────────────

    if (state.phase === 'phase3_consensus') {
      const code   = state.generatedCode!
      const files  = state.generatedFiles ?? { 'output.txt': code }
      const review = state.lastReview!

      let decision: Awaited<ReturnType<typeof runPhase3Consensus>>
      try {
        const syntheticReview: ReviewPayload = { ...review, consensus: true }
        decision = await runPhase3Consensus(
          projectId, sessionId, code, files, syntheticReview, ctx, emit,
        )
      } catch (err) {
        await handleError(state, err, emit)
        return
      }

      if (decision.promote) {
        state.output         = decision.output
        state.generatedFiles = files
        state.currentFileIndex = 0
        // Save output metadata (not the actual files — those go to disk on file-accept)
        saveProjectOutput(state.userId, state.projectId, decision.output!, state.spec ?? null, state.sessionId)
          .catch(err => console.error('[orchestrator] saveProjectOutput failed:', err))
        // Transition to file gate — stream closes here, client reconnects after user acts
        state = await transition(state, 'phase3_file_gate')
        return
      }

      state = await transition(state, 'conflict_escalated')
      return
    }
  }

  // ── File gate — emit file_ready for current file index ─────────────────────
  // Reached when client reconnects after the user accepts a file and the gate
  // advances to the next file (or all files are done).

  if (state.phase === 'phase3_file_gate') {
    const files     = state.generatedFiles ?? {}
    const filenames = Object.keys(files)
    const idx       = state.currentFileIndex ?? 0

    if (idx >= filenames.length) {
      // All files accepted — pipeline is complete
      emit({ type: 'files_complete', acceptedFiles: files })
      emit({ type: 'done' })
      state = await transition(state, 'complete')
      return
    }

    // Emit phase_change first so client's lastPhaseRef becomes 'phase3_file_gate'
    // (in NO_AUTO_RECONNECT) before the stream closes — prevents reconnect loop.
    emit({ type: 'phase_change', phase: 'phase3_file_gate' })
    const filename = filenames[idx]!
    emit({ type: 'file_ready', filename, code: files[filename]!, fileIndex: idx, totalFiles: filenames.length })
    emit({ type: 'done' })
    await saveSessionState(state)
    return
  }

  if (state.phase === 'conflict_escalated') return
}

// ─── Error handler ────────────────────────────────────────────────────────────

async function handleError(
  state: PipelineSessionState,
  err:   unknown,
  emit:  (event: SSEEvent) => void,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[orchestrator] Error in phase ${state.phase}:`, message)

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
  return {
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
}

export { getAdapter }
export type { PipelineSessionState, PipelineConfig }
