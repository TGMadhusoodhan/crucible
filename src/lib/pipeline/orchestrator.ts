import fs   from 'fs'
import path from 'path'
import { getAdapter } from '@/lib/adapters'
import { getBudgetStatus, recordUsage } from '@/lib/budget'
import { dbg } from '@/lib/debug'
import { appendSessionLog, logBudgetModeChange, logPause, logPlay, logStop } from '@/lib/memory/session-log'
import { capturePipelineError } from '@/lib/sentry'
import { generateId } from '@/lib/utils'
import { estimateTokens } from '@/lib/utils/tokens'
import { mergeReviewHunks, applyResolvedHunks } from '@/lib/utils/hunk-merge'
import { runPhase0Context }        from './phase0-context'
import { runPhase1Thinking }       from './phase1-thinking'
import { runPhase1_5Alignment }    from './phase1-5-alignment'
import { runPhase2Questions }      from './phase2-questions'
import { detectContradictions }    from './phase2-contradiction'
import { runPhase2SpecAndManifest } from './phase2-spec'
import { runPhase3Generate }       from './phase3-generate'
import { runPhase3Review }         from './phase3-review'
import { runPhase3CrossReview }    from './phase3-cross-review'
import { runPhase3Patch }          from './phase3-patch'
import type {
  ArbitrationPackage,
  BudgetMode,
  ConsensusOutput,
  ContextInput,
  PipelineConfig,
  PipelinePhase,
  PipelineSessionState,
  Provider,
  ResolvedHunk,
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

  dbg.orch('createSession', {
    sessionId,
    projectId:    params.projectId,
    coderProvider:params.config.coderProvider,
    coderModelId: params.config.coderModelId,
    r1Provider:   params.config.r1Provider,
    r1ModelId:    params.config.r1ModelId,
    r2Provider:   params.config.r2Provider,
    r2ModelId:    params.config.r2ModelId,
    hasContext:   !!contextText,
  })

  const state: PipelineSessionState = {
    sessionId,
    projectId:           params.projectId,
    userId:              params.userId,
    phase:               'phase1_thinking',
    config:              params.config,

    currentFileIdx:      0,
    currentFilename:     null,
    totalFiles:          0,
    round:               1,

    taskDescription:     params.taskDescription,
    contextText:         contextText || undefined,

    r1Hunks:             [],
    r2Hunks:             [],
    conflicts:           [],
    resolvedHunks:       [],
    patchedCode:         undefined,
    currentFileCode:     undefined,

    acceptedFiles:       {},
    streamingCode:       '',

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
  state.answers = answers
  state.phase = 'phase2_contradiction_check'
  await saveSessionState(state)
}

export async function confirmSpec(sessionId: string): Promise<void> {
  const state = await getSessionState(sessionId)
  if (!state) throw new Error(`Session not found: ${sessionId}`)
  if (state.phase !== 'phase2_confirm') {
    throw new Error(`Session is not waiting for spec confirmation (current phase: ${state.phase})`)
  }
  if (state.spec) {
    state.spec.human_confirmed = true
    state.spec.confirmed_at    = new Date().toISOString()
  }
  state.phase = 'phase3_generating'
  await saveSessionState(state)
}

// ─── Micro-gate + arbitration resolution (HUMAN GATE 3 / 4) ──────────────────
// These only mutate + persist state — they do NOT call runPipeline themselves.
// Every other gate-resolution endpoint in this app (submitAnswers, confirmSpec,
// play) follows the same pattern: the client reconnects to /api/pipeline/stream
// afterward, and THAT is what drives runPipeline forward. Calling runPipeline
// from here too would race the client's reconnect against this background
// invocation for the same session.

export async function resolveMicroGate(
  sessionId:  string,
  conflictId: string,
  choice:     'R1' | 'R2',
): Promise<void> {
  const state = await getSessionState(sessionId)
  if (!state) throw new Error(`Session not found: ${sessionId}`)
  if (state.phase !== 'phase3_micro_gate') {
    throw new Error(`Session is not waiting at the micro-gate (current phase: ${state.phase})`)
  }

  const conflicts = state.conflicts ?? []
  const conflict  = conflicts.find(c => c.id === conflictId)
  if (!conflict) throw new Error(`Conflict not found: ${conflictId}`)

  const chosenHunk = choice === 'R1' ? conflict.r1_hunk : conflict.r2_hunk
  const resolvedHunk: ResolvedHunk = {
    filename:   conflict.filename,
    line_start: conflict.line_start,
    line_end:   conflict.line_end,
    new_code:   chosenHunk.fixed_code,
    source:     'human',
    flag_ids:   [conflict.r1_hunk.id, conflict.r2_hunk.id],
  }

  state.resolvedHunks = [...(state.resolvedHunks ?? []), resolvedHunk]
  state.conflicts     = conflicts.filter(c => c.id !== conflictId)

  if (state.conflicts.length === 0) {
    state.phase = 'phase3_patching'
  }
  await saveSessionState(state)
}

export async function resolveArbitration(
  sessionId: string,
  filename:  string,
  choice:    'r1' | 'r2' | 'accept' | 'regenerate',
  guidance?: string,
): Promise<void> {
  const state = await getSessionState(sessionId)
  if (!state) throw new Error(`Session not found: ${sessionId}`)
  if (state.phase !== 'phase3_arbitration') {
    throw new Error(`Session is not waiting at arbitration (current phase: ${state.phase})`)
  }
  const pkg = state.arbitrationPkg
  if (!pkg) throw new Error('No arbitration package pending for this session')

  const totalFiles = state.fileManifest?.generation_order.length ?? 0

  if (choice === 'r1' || choice === 'r2') {
    // The human already made the call — apply the chosen side's hunks
    // deterministically (no LLM judgment needed) and accept immediately.
    const wantedSource = choice === 'r1' ? 'R1' : 'R2'
    const chosenHunks  = pkg.unresolved_hunks.filter(h => h.source === wantedSource)
    const resolved: ResolvedHunk[] = chosenHunks.map(h => ({
      filename:   h.filename,
      line_start: h.line_start,
      line_end:   h.line_end,
      new_code:   h.fixed_code,
      source:     'human',
      flag_ids:   [h.id],
    }))
    const baseCode  = state.patchedCode ?? state.currentFileCode ?? ''
    const finalCode = applyResolvedHunks(baseCode, resolved)

    state.acceptedFiles[filename] = finalCode
    state.currentFileIdx += 1
    state.round = 1
    resetPerFileState(state)
    state.phase = state.currentFileIdx < totalFiles ? 'phase3_generating' : 'output_gate'
  } else if (choice === 'accept') {
    const finalCode = state.patchedCode ?? state.currentFileCode ?? ''
    state.acceptedFiles[filename] = finalCode
    state.currentFileIdx += 1
    state.round = 1
    resetPerFileState(state)
    state.phase = state.currentFileIdx < totalFiles ? 'phase3_generating' : 'output_gate'
  } else {
    // regenerate — round is uncapped this time; stays on the same file
    state.round += 1
    resetPerFileState(state)
    state.phase = 'phase3_generating'
  }

  if (guidance) state.pendingHumanOverrides = [...state.pendingHumanOverrides, guidance]

  await saveSessionState(state)
}

// ─── Output gate (HUMAN GATE 5) ───────────────────────────────────────────────
// By the time a file reaches the output gate it has already passed the full
// dual-review loop (or a human already resolved its conflicts). This is the
// human's final skim before the session is marked complete and persisted.

export async function acceptOutputFile(sessionId: string, filename: string): Promise<{ done: boolean }> {
  const state = await getSessionState(sessionId)
  if (!state) throw new Error(`Session not found: ${sessionId}`)
  if (state.phase !== 'output_gate') {
    throw new Error(`Session is not waiting at the output gate (current phase: ${state.phase})`)
  }

  const order  = state.fileManifest?.generation_order ?? Object.keys(state.acceptedFiles)
  const isLast = order.length === 0 || filename === order[order.length - 1]

  if (isLast) {
    const output: ConsensusOutput = {
      code:          JSON.stringify(state.acceptedFiles),
      files:         state.acceptedFiles,
      promoted_at:   Date.now(),
      checkpoint_id: generateId(),
    }
    state.output = output
    state.phase  = 'complete'
    await saveSessionState(state)
    await saveProjectOutput(state.userId, state.projectId, output, state.spec ?? null, sessionId)
    return { done: true }
  }

  return { done: false }
}

export async function applyOutputFix(
  sessionId:   string,
  filename:    string,
  instruction: string,
): Promise<{ code: string; modelId: string }> {
  const state = await getSessionState(sessionId)
  if (!state) throw new Error(`Session not found: ${sessionId}`)
  if (state.phase !== 'output_gate') {
    throw new Error(`Session is not waiting at the output gate (current phase: ${state.phase})`)
  }
  const currentCode = state.acceptedFiles[filename]
  if (currentCode === undefined) throw new Error(`File not found in accepted output: ${filename}`)

  const coderAdapter = getAdapter(state.config.coderProvider, state.config.coderModelId, state.config.coderApiKey)
  const { code } = await coderAdapter.fixFile(filename, currentCode, instruction, () => {})

  state.acceptedFiles[filename] = code
  await saveSessionState(state)
  return { code, modelId: coderAdapter.getModelId() }
}

// ─── Alignment skip heuristic ─────────────────────────────────────────────────

function canSkipAlignment(r1: ThinkingOutput, r2: ThinkingOutput): boolean {
  if (r1.understood_as === 'Model returned unparseable output') return false
  if (r2.understood_as === 'Model returned unparseable output') return false
  const reqCount = [...r1.questions, ...r2.questions].filter(q => q.is_required).length
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
  provider: Provider,
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
  dbg.orch(`transition ${state.phase} → ${phase}`, { sessionId: state.sessionId, round: state.round })
  state.phase = phase
  await saveSessionState(state)
  return state
}

// ─── Per-file state reset (between rounds / after a file is accepted) ────────

function resetPerFileState(state: PipelineSessionState): void {
  state.currentFileCode = undefined
  state.r1Hunks          = []
  state.r2Hunks          = []
  state.resolvedHunks    = []
  state.conflicts        = []
  state.patchedCode      = undefined
  state.arbitrationPkg   = undefined
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

  dbg.orch('runPipeline start', {
    sessionId,
    phase:        state.phase,
    coderProvider:config.coderProvider,
    r1Provider:   config.r1Provider,
    r2Provider:   config.r2Provider,
  })

  const coderAdapter = getAdapter(config.coderProvider, config.coderModelId, config.coderApiKey)
  const r1Adapter     = getAdapter(config.r1Provider,    config.r1ModelId,    config.r1ApiKey)
  const r2Adapter     = getAdapter(config.r2Provider,    config.r2ModelId,    config.r2ApiKey)

  const maybeStop = async (): Promise<boolean> => {
    const signal = await checkControl(sessionId)
    if (signal === 'stop') {
      state = await transition(state!, 'stopped')
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
    dbg.phase1('starting parallel think', {
      r1: `${config.r1Provider}:${config.r1ModelId}`,
      r2: `${config.r2Provider}:${config.r2ModelId}`,
      taskLen: state.taskDescription.length,
    })

    try {
      const result = await runPhase1Thinking(
        projectId, sessionId, state.taskDescription,
        r1Adapter, r2Adapter, emit, state.contextText,
      )
      state.thinkingOutputs = { r1: result.r1, r2: result.r2 }
      dbg.phase1('both models done', {
        r1Tokens: result.r1.tokens_used,
        r2Tokens: result.r2.tokens_used,
        r1Qs:     result.r1.questions.length,
        r2Qs:     result.r2.questions.length,
      })
      const taskTokens = estimateTokens(state.taskDescription)
      recordAndRefreshBudget(state, config.r1Provider, config.r1ModelId,
        taskTokens, result.r1.tokens_used, emit)
      recordAndRefreshBudget(state, config.r2Provider, config.r2ModelId,
        taskTokens, result.r2.tokens_used, emit)
      state = await transition(state, 'phase1_5_alignment')
    } catch (err) {
      await handleError(state, err, emit)
      return
    }
  }

  // ─── Phase 1.5: Alignment ─────────────────────────────────────────────────

  let alignmentMessagesForQuestions = state.alignmentMessages ?? []
  let agreedQuestionsFromAlignment  = state.thinkingOutputs
    ? [...state.thinkingOutputs.r1.questions, ...state.thinkingOutputs.r2.questions]
    : []

  if (state.phase === 'phase1_5_alignment') {
    if (await maybeStop()) return
    dbg.align('evaluating alignment skip heuristic')

    try {
      const { r1: r1Think, r2: r2Think } = state.thinkingOutputs!

      if (canSkipAlignment(r1Think, r2Think)) {
        dbg.align('SKIPPED — models agree, moving to phase2_questions')
        alignmentMessagesForQuestions = []
        agreedQuestionsFromAlignment  = [...r1Think.questions, ...r2Think.questions]
      } else {
        dbg.align('running alignment rounds')
        const result = await runPhase1_5Alignment(
          projectId, sessionId, state.taskDescription,
          r1Think, r2Think, r1Adapter, r2Adapter, emit, state.contextText,
        )
        alignmentMessagesForQuestions = result.messages
        agreedQuestionsFromAlignment  = result.agreed_questions
        dbg.align('alignment done', {
          rounds:    result.rounds_taken,
          mismatch:  result.architectural_mismatch_detected,
          conflicts: result.unresolved_conflicts.length,
        })
      }
      state.alignmentMessages = alignmentMessagesForQuestions
      state = await transition(state, 'phase2_questions')
    } catch (err) {
      await handleError(state, err, emit)
      return
    }
  }

  // ─── Phase 2: Questions ───────────────────────────────────────────────────

  if (state.phase === 'phase2_questions') {
    if (await maybeStop()) return
    dbg.phase2('building question list')

    try {
      const questions = await runPhase2Questions(
        projectId, sessionId,
        state.thinkingOutputs!.r1,
        state.thinkingOutputs!.r2,
        {
          messages:                        alignmentMessagesForQuestions,
          agreed_questions:                agreedQuestionsFromAlignment,
          agreed_recommendations:          [],
          unresolved_conflicts:            [],
          architectural_mismatch_detected: false,
          rounds_taken:                    alignmentMessagesForQuestions.length > 2 ? 2 : 1,
          total_tokens:                    0,
        },
        emit,
      )
      state.questions = questions

      const autoAnswers: Record<string, string> = { ...(state.answers ?? {}) }
      for (const q of questions) {
        if (!q.is_required && q.recommended_option_id && !autoAnswers[q.id]) {
          autoAnswers[q.id] = q.recommended_option_id
        }
      }
      state.answers = autoAnswers

      const hasUnansweredRequired = questions.some(q => q.is_required && !autoAnswers[q.id])
      dbg.phase2('questions ready', {
        total: questions.length,
        required: questions.filter(q => q.is_required).length,
        needsHuman: hasUnansweredRequired,
      })

      if (hasUnansweredRequired) {
        state = await transition(state, 'phase2_answering')
        return
      }
      state = await transition(state, 'phase2_contradiction_check')
    } catch (err) {
      await handleError(state, err, emit)
      return
    }
  }

  if (state.phase === 'phase2_answering') return

  // ─── Phase 2: Contradiction detection ────────────────────────────────────

  if (state.phase === 'phase2_contradiction_check') {
    if (await maybeStop()) return
    dbg.phase2('running contradiction detection')

    const contradictions = detectContradictions(state.questions!, state.answers!)
    state.contradictions = contradictions
    dbg.phase2('contradiction detection done', { contradictions: contradictions.length })

    for (const c of contradictions) {
      emit({ type: 'contradiction', contradiction: c })
    }

    state = await transition(state, 'phase2_spec_and_manifest')
  }

  // ─── Phase 2: Spec + Manifest (R1 + R2 jointly propose) ──────────────────

  if (state.phase === 'phase2_spec_and_manifest') {
    if (await maybeStop()) return
    dbg.phase2('R1+R2 proposing spec + manifest')

    try {
      const { spec, manifest } = await runPhase2SpecAndManifest(
        projectId, sessionId, state.taskDescription,
        state.questions!, state.answers!, r1Adapter, r2Adapter, emit, state.contextText,
      )
      state.spec         = spec
      state.fileManifest = manifest
      dbg.phase2('spec + manifest ready — waiting for human confirmation', {
        criteria: spec.acceptance_criteria.length,
        edgeCases: spec.edge_cases.length,
        files:    manifest.files.length,
      })
      state = await transition(state, 'phase2_confirm')
      return
    } catch (err) {
      await handleError(state, err, emit)
      return
    }
  }

  if (state.phase === 'phase2_confirm') {
    dbg.phase2('GATE: waiting for human spec+manifest confirmation')
    return
  }

  // ─── Phase 3: per-file generate → review → cross-review → patch loop ────

  const getOrder = () => state!.fileManifest?.generation_order ?? ['output.ts']

  async function acceptCurrentFile(): Promise<void> {
    const filename = getOrder()[state!.currentFileIdx]!
    const code = state!.patchedCode ?? state!.currentFileCode!
    state!.acceptedFiles[filename] = code
    emit({ type: 'file_accepted', filename, code })
    await appendSessionLog(projectId, sessionId, {
      phase: 'phase3_re_review', actor: 'system',
      summary: `File accepted: ${filename}`,
    })
  }

  while (state.currentFileIdx < getOrder().length) {
    const filename    = getOrder()[state.currentFileIdx]!
    const totalFiles  = getOrder().length
    state.currentFilename = filename
    state.totalFiles      = totalFiles

    if (await maybeStop()) return

    // ── 3a: Generate ──────────────────────────────────────────────────────

    if (state.phase === 'phase3_generating') {
      try {
        const code = await runPhase3Generate(
          projectId, sessionId, filename, state.currentFileIdx,
          totalFiles, state.fileManifest!, state.spec!, coderAdapter,
          state.acceptedFiles, emit, state.contextText,
        )
        state.currentFileCode = code
        state = await transition(state, 'phase3_reviewing')
      } catch (err) {
        await handleError(state, err, emit)
        return
      }
    }

    // ── 3b: R1 + R2 review in parallel ────────────────────────────────────

    if (state.phase === 'phase3_reviewing') {
      try {
        const previousHighHunks = state.round > 1
          ? [...(state.r1Hunks ?? []), ...(state.r2Hunks ?? [])].filter(h => h.severity === 'HIGH')
          : undefined

        const { r1, r2 } = await runPhase3Review(
          projectId, sessionId, filename, state.currentFileCode!,
          state.spec!, state.fileManifest!, state.round,
          r1Adapter, r2Adapter, emit, previousHighHunks,
        )
        state.r1Hunks = r1
        state.r2Hunks = r2

        const anyHigh = [...r1, ...r2].some(h => h.severity === 'HIGH')
        if (!anyHigh) {
          await acceptCurrentFile()
          state.currentFileIdx += 1
          state.round = 1
          resetPerFileState(state)
          if (state.currentFileIdx < getOrder().length) {
            state = await transition(state, 'phase3_generating')
          } else {
            emit({ type: 'output_gate_ready', files: state.acceptedFiles })
            state = await transition(state, 'output_gate')
            return
          }
          continue
        }

        const { resolved, conflicts } = mergeReviewHunks(
          r1.filter(h => h.severity === 'HIGH'),
          r2.filter(h => h.severity === 'HIGH'),
          { [filename]: state.currentFileCode! },
        )

        state.resolvedHunks = resolved
        state.conflicts     = conflicts

        emit({ type: 'hunks_merged', resolved, conflicts })

        if (conflicts.length > 0) {
          state = await transition(state, 'phase3_cross_review')
        } else {
          state = await transition(state, 'phase3_patching')
        }
      } catch (err) {
        await handleError(state, err, emit)
        return
      }
    }

    // ── 3c: Cross-review conflicts ────────────────────────────────────────

    if (state.phase === 'phase3_cross_review') {
      try {
        const { resolved, stillConflicting } = await runPhase3CrossReview(
          projectId, sessionId, state.conflicts!, r1Adapter, r2Adapter, emit,
        )

        state.resolvedHunks = [...(state.resolvedHunks ?? []), ...resolved]

        if (stillConflicting.length > 0) {
          // micro_gate emitted inside runPhase3CrossReview
          state.conflicts = stillConflicting
          state = await transition(state, 'phase3_micro_gate')
          return
        }

        state.conflicts = []
        state = await transition(state, 'phase3_patching')
      } catch (err) {
        await handleError(state, err, emit)
        return
      }
    }

    if (state.phase === 'phase3_micro_gate') return

    // ── 3e: DeepSeek applies resolved patches ─────────────────────────────

    if (state.phase === 'phase3_patching') {
      try {
        const patchedCode = await runPhase3Patch(
          projectId, sessionId, filename,
          state.currentFileCode!, state.resolvedHunks!,
          coderAdapter, emit,
        )
        state.patchedCode = patchedCode
        state = await transition(state, 'phase3_re_review')
      } catch (err) {
        await handleError(state, err, emit)
        return
      }
    }

    // ── 3f: Re-review patched file ────────────────────────────────────────

    if (state.phase === 'phase3_re_review') {
      try {
        const { r1: r1New, r2: r2New } = await runPhase3Review(
          projectId, sessionId, filename, state.patchedCode!,
          state.spec!, state.fileManifest!, state.round,
          r1Adapter, r2Adapter, emit,
        )

        // Tag each hunk with its origin — reviewAndPatch()'s output never sets
        // .source, and resolveArbitration's 'r1'/'r2' choice depends on it to
        // pick the right hunks out of pkg.unresolved_hunks.
        const highRemaining = [
          ...r1New.filter(h => h.severity === 'HIGH').map(h => ({ ...h, source: 'R1' as const })),
          ...r2New.filter(h => h.severity === 'HIGH').map(h => ({ ...h, source: 'R2' as const })),
        ]

        if (highRemaining.length === 0) {
          state.currentFileCode = state.patchedCode!
          await acceptCurrentFile()
          state.currentFileIdx += 1
          state.round = 1
          resetPerFileState(state)
          if (state.currentFileIdx < getOrder().length) {
            state = await transition(state, 'phase3_generating')
          } else {
            emit({ type: 'output_gate_ready', files: state.acceptedFiles })
            state = await transition(state, 'output_gate')
            return
          }
        } else if (state.round < 3) {
          const patched = state.patchedCode!
          state.round += 1
          resetPerFileState(state)
          state.currentFileCode = patched
          state.r1Hunks = r1New
          state.r2Hunks = r2New
          state = await transition(state, 'phase3_reviewing')
        } else {
          const pkg: ArbitrationPackage = {
            filename,
            round: state.round,
            unresolved_hunks: highRemaining,
            r1_summary: `R1 flagged ${r1New.filter(h => h.severity === 'HIGH').length} issues`,
            r2_summary: `R2 flagged ${r2New.filter(h => h.severity === 'HIGH').length} issues`,
          }
          state.arbitrationPkg = pkg
          emit({ type: 'arbitration', pkg })
          state = await transition(state, 'phase3_arbitration')
          return
        }
      } catch (err) {
        await handleError(state, err, emit)
        return
      }
    }

    if (state.phase === 'phase3_arbitration') return
  }

  if (state.phase === 'output_gate') return
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
  state.error = message
  await saveSessionState(state)

  emit({ type: 'error', message, phase: state.phase })
  emit({ type: 'done' })
}

export { getAdapter }
export type { PipelineConfig, PipelineSessionState }
