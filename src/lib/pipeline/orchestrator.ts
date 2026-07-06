import fs   from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { getAdapter } from '@/lib/adapters'
import { computeCostUsd } from '@/lib/adapters/base'
import { getBudgetStatus, recordUsage } from '@/lib/budget'
import { decrypt } from '@/lib/crypto'
import { db, schema } from '@/lib/db'
import { dbg } from '@/lib/debug'
import { appendSessionLog, logBudgetModeChange, logPause, logPlay, logStop } from '@/lib/memory/session-log'
import { capturePipelineError } from '@/lib/sentry'
import { generateId } from '@/lib/utils'
import { estimateTokens } from '@/lib/utils/tokens'
import { mergeReviewHunks, applyResolvedHunks } from '@/lib/utils/hunk-merge'
import { prepareWorkspaceForSession, writeAcceptedFile } from '@/lib/workspace'
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
import { verifyFile }              from './verify'
import type {
  ArbitrationPackage,
  BudgetMode,
  ConsensusOutput,
  ContextInput,
  PipelineConfig,
  PipelinePhase,
  PipelineSessionState,
  PreviousHunkRecord,
  Provider,
  ResolvedHunk,
  ReviewHunk,
  SpecDocument,
  SSEEvent,
  ThinkingOutput,
} from '@/types'

// ─── In-memory stores (global singleton — survives Next.js hot reload) ────────

declare global {
  var __sessionStore:    Map<string, PipelineSessionState>             | undefined
  var __controlStore:    Map<string, 'pause' | 'stop'>                | undefined
  var __runningStore:    Map<string, boolean>                          | undefined
  var __subscriberStore: Map<string, Set<(e: SSEEvent) => void>>      | undefined
}

const sessionStore: Map<string, PipelineSessionState> =
  global.__sessionStore    ??= new Map()

const controlStore: Map<string, 'pause' | 'stop'> =
  global.__controlStore    ??= new Map()

// Run-lock: prevents concurrent runPipeline invocations on the same session.
// Subscriber set: all active SSE connections for a session share one runner.
const runningStore:    Map<string, boolean>                     =
  global.__runningStore    ??= new Map()
const subscriberStore: Map<string, Set<(e: SSEEvent) => void>> =
  global.__subscriberStore ??= new Map()

export function removeSubscriber(sessionId: string, fn: (e: SSEEvent) => void): void {
  subscriberStore.get(sessionId)?.delete(fn)
}

// ─── Session state CRUD ───────────────────────────────────────────────────────

// Re-hydrate API keys from the encrypted credentials table (keys are never
// persisted — the stateJson stored in SQLite always has empty-string keys).
async function rehydrateApiKeys(state: PipelineSessionState): Promise<void> {
  const fetchKey = async (provider: string): Promise<string> => {
    const [row] = await db
      .select({ encryptedKey: schema.apiCredentials.encryptedKey, isValid: schema.apiCredentials.isValid })
      .from(schema.apiCredentials)
      .where(eq(schema.apiCredentials.provider, provider))
      .limit(1)
    if (!row?.isValid) return ''
    try { return decrypt(row.encryptedKey) } catch { return '' }
  }
  const [coderKey, r1Key, r2Key] = await Promise.all([
    fetchKey(state.config.coderProvider),
    fetchKey(state.config.r1Provider),
    fetchKey(state.config.r2Provider),
  ])
  state.config.coderApiKey = coderKey
  state.config.r1ApiKey    = r1Key
  state.config.r2ApiKey    = r2Key
}

// SQLite upsert — fire-and-forget from saveSessionState.
// API keys are stripped from config before serialisation.
async function persistSessionToDb(state: PipelineSessionState): Promise<void> {
  const safeConfig = {
    ...state.config,
    coderApiKey: '',  // NEVER persist decrypted keys
    r1ApiKey:    '',
    r2ApiKey:    '',
  }
  const stateJson = JSON.stringify({ ...state, config: safeConfig })
  await db.insert(schema.pipelineSessions)
    .values({
      sessionId: state.sessionId,
      projectId: state.projectId,
      phase:     state.phase,
      stateJson,
      updatedAt: state.updatedAt,
    })
    .onConflictDoUpdate({
      target: schema.pipelineSessions.sessionId,
      set:    { phase: state.phase, stateJson, updatedAt: state.updatedAt },
    })
}

// Guard against scheduling multiple delete timers for the same session if
// saveSessionState is called more than once in a terminal phase.
const cleanupScheduled = new Set<string>()

// Schedule 24-hour SQLite cleanup for terminal states (output lives on filesystem).
// If the server restarts before the timer fires, the 7-day startup purge in db/index.ts catches it.
function scheduleDbCleanup(sessionId: string): void {
  if (cleanupScheduled.has(sessionId)) return
  cleanupScheduled.add(sessionId)
  setTimeout(() => {
    cleanupScheduled.delete(sessionId)
    db.delete(schema.pipelineSessions)
      .where(eq(schema.pipelineSessions.sessionId, sessionId))
      .catch(() => {})
  }, 24 * 60 * 60 * 1000)
}

export async function getSessionState(sessionId: string): Promise<PipelineSessionState | null> {
  // Hot path: in-memory (covers all normal operation)
  const cached = sessionStore.get(sessionId)
  if (cached) return cached

  // Cold path: SQLite (crash recovery — process was killed between writes)
  const [row] = await db
    .select()
    .from(schema.pipelineSessions)
    .where(eq(schema.pipelineSessions.sessionId, sessionId))
    .limit(1)
  if (!row) return null

  let state: PipelineSessionState
  try {
    state = JSON.parse(row.stateJson) as PipelineSessionState
  } catch (err) {
    console.error('[session] failed to parse persisted state:', err)
    return null
  }

  // Re-inject API keys (they were stripped before saving)
  try {
    await rehydrateApiKeys(state)
  } catch (err) {
    console.error('[session] failed to re-hydrate API keys:', err)
  }

  // Warm the in-memory cache so subsequent reads skip SQLite
  sessionStore.set(sessionId, state)
  return state
}

export async function saveSessionState(state: PipelineSessionState): Promise<void> {
  state.updatedAt = Date.now()
  sessionStore.set(state.sessionId, state)
  // SQLite write is fire-and-forget — never block the pipeline on it
  persistSessionToDb(state).catch(err =>
    console.error('[session] sqlite write failed:', err),
  )
  // Schedule cleanup for terminal states
  if (state.phase === 'complete' || state.phase === 'stopped' || state.phase === 'error') {
    scheduleDbCleanup(state.sessionId)
  }
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
  workspaceDir?:   string | null
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
    workspaceDir:        params.workspaceDir ?? null,

    currentFileIdx:      0,
    currentFilename:     null,
    totalFiles:          0,
    round:               1,

    taskDescription:     params.taskDescription,
    contextText:         contextText || undefined,

    r1Hunks:              [],
    r2Hunks:              [],
    conflicts:            [],
    resolvedHunks:        [],
    patchedCode:          undefined,
    currentFileCode:      undefined,
    previousHunkRecords:  undefined,
    compilerErrors:       undefined,
    regenAttempted:       false,
    regenHint:            undefined,

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
    filename:      conflict.filename,
    line_start:    conflict.line_start,
    line_end:      conflict.line_end,
    original_code: conflict.original_code,
    new_code:      chosenHunk.fixed_code,
    source:        'human',
    flag_ids:      [conflict.r1_hunk.id, conflict.r2_hunk.id],
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
      filename:      h.filename,
      line_start:    h.line_start,
      line_end:      h.line_end,
      original_code: h.original_code,
      new_code:      h.fixed_code,
      source:        'human' as const,
      flag_ids:      [h.id],
    }))
    const baseCode  = state.patchedCode ?? state.currentFileCode ?? ''
    const { code: finalCode } = applyResolvedHunks(baseCode, resolved)

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

// ─── Budget gate (CRITICAL mode) ─────────────────────────────────────────────
// Mutates state only — does NOT call runPipeline. Client reconnects to stream
// afterward and THAT drives pipeline forward (same pattern as resolveMicroGate).

export async function resolveBudgetGate(sessionId: string): Promise<void> {
  const state = await getSessionState(sessionId)
  if (!state) throw new Error(`Session not found: ${sessionId}`)
  if (state.phase !== 'phase3_budget_gate') {
    throw new Error(`Session is not waiting at the budget gate (current phase: ${state.phase})`)
  }
  state.budgetGateCleared = true
  state.phase = 'phase3_generating'
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

  if (state.workspaceDir) {
    writeAcceptedFile(state.workspaceDir, filename, code, sessionId, state.round).catch(err => {
      console.warn('[workspace] fix write failed for', filename, ':', err instanceof Error ? err.message : err)
    })
  }

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
  state:             PipelineSessionState,
  provider:          Provider,
  modelId:           string,
  tokensIn:          number,
  tokensOut:         number,
  emit:              (event: SSEEvent) => void,
  cacheReadTokens?:  number,
  cacheWriteTokens?: number,
): void {
  recordUsage(state.userId, state.sessionId, provider, modelId, tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens)
    .catch(err => console.error('[budget] recordUsage failed:', err))

  // Emit live cost + cache efficiency metrics to the UI.
  const cr = cacheReadTokens  ?? 0
  const cw = cacheWriteTokens ?? 0
  const costUsd = computeCostUsd(modelId, tokensIn, tokensOut, cr, cw)
  emit({ type: 'usage_update', provider, modelId, tokensIn, tokensOut, cacheReadTokens: cr, cacheWriteTokens: cw, costUsd })

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
  state.currentFileCode     = undefined
  state.r1Hunks             = []
  state.r2Hunks             = []
  state.resolvedHunks       = []
  state.conflicts           = []
  state.patchedCode         = undefined
  state.arbitrationPkg      = undefined
  state.previousHunkRecords = undefined
  state.compilerErrors      = undefined
  state.regenAttempted      = false
  state.regenHint           = undefined
  state.budgetGateCleared   = false  // next file must re-clear the gate in CRITICAL mode
}

// ─── Build PreviousHunkRecord list from applied resolved hunks ────────────────
// Maps each resolved hunk back to the original ReviewHunk issue text so the
// re-review prompt can ask for FIXED/NOT_FIXED verdicts per issue ID.

function buildPreviousHunkRecords(
  resolvedHunks: ResolvedHunk[],
  r1Hunks:       ReviewHunk[],
  r2Hunks:       ReviewHunk[],
): PreviousHunkRecord[] {
  const allHunks = [...r1Hunks, ...r2Hunks]
  return resolvedHunks.flatMap(rh => {
    // Each flag_id links back to an original ReviewHunk
    return rh.flag_ids.map(id => {
      const orig = allHunks.find(h => h.id === id)
      return {
        id,
        issue:         orig?.issue         ?? 'issue',
        original_code: rh.original_code    ?? orig?.original_code ?? '',
        fixed_code:    rh.new_code,
      }
    })
  })
}

// ─── Main pipeline runner (resumable state machine) ──────────────────────────

export async function runPipeline(
  sessionId:     string,
  externalEmit?: (event: SSEEvent) => void,
): Promise<void> {
  // Attach subscriber BEFORE checking the lock so this connection receives events
  // even if the pipeline is already running (second browser tab, SSE reconnect, etc.)
  if (externalEmit) {
    let subs = subscriberStore.get(sessionId)
    if (!subs) { subs = new Set(); subscriberStore.set(sessionId, subs) }
    subs.add(externalEmit)
  }

  // Run-lock: check and set synchronously (no await between) — safe in Node's event loop.
  if (runningStore.get(sessionId)) return  // already running; subscriber is attached above

  runningStore.set(sessionId, true)

  // Broadcast emit — all active SSE connections for this session receive the same events.
  const emit = (event: SSEEvent): void => {
    const subs = subscriberStore.get(sessionId)
    if (!subs) return
    for (const fn of [...subs]) {
      try { fn(event) } catch { /* closed connection — silently skip */ }
    }
  }

  try {
    let state = await getSessionState(sessionId)
    if (!state) throw new Error(`Session not found: ${sessionId}`)

    if (state.phase === 'paused') {
      const resumePhase = state.previousPhase ?? 'phase3_generating'
      state.previousPhase = undefined
      state = await transition(state, resumePhase)
    }

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

    // Wire retry emitters so provider_retry SSE events reach the client
    const makeRetryEmit = (provider: Provider) => (attempt: number, delayMs: number) =>
      emit({ type: 'provider_retry', provider, attempt, delayMs })
    coderAdapter.setRetryEmitter(makeRetryEmit(config.coderProvider))
    r1Adapter.setRetryEmitter(makeRetryEmit(config.r1Provider))
    r2Adapter.setRetryEmitter(makeRetryEmit(config.r2Provider))

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
  // Structure: generate → [review → merge → (cross-review) → patch → verify → next round review]
  // The NEXT round's review IS the verification of the previous patch — no separate re_review step.

  const getOrder = () => state!.fileManifest?.generation_order ?? ['output.ts']

  async function acceptCurrentFile(codeOverride?: string): Promise<void> {
    const fname = getOrder()[state!.currentFileIdx]!
    const code  = codeOverride ?? state!.patchedCode ?? state!.currentFileCode!
    state!.acceptedFiles[fname] = code
    emit({ type: 'file_accepted', filename: fname, code })
    await appendSessionLog(projectId, sessionId, {
      phase: 'phase3_reviewing', actor: 'system',
      summary: `File accepted: ${fname}`,
    })
    if (state!.workspaceDir) {
      writeAcceptedFile(state!.workspaceDir, fname, code, sessionId, state!.round).catch(err => {
        console.warn('[workspace] write failed for', fname, ':', err instanceof Error ? err.message : err)
      })
    }
  }

  async function advanceToNextFile(): Promise<boolean> {
    state!.currentFileIdx += 1
    state!.round = 1
    resetPerFileState(state!)
    if (state!.currentFileIdx < getOrder().length) {
      state = await transition(state!, 'phase3_generating')
      return true
    }
    emit({ type: 'output_gate_ready', files: state!.acceptedFiles })
    state = await transition(state!, 'output_gate')
    return false
  }

  while (state.currentFileIdx < getOrder().length) {
    const filename    = getOrder()[state.currentFileIdx]!
    const totalFiles  = getOrder().length
    state.currentFilename = filename
    state.totalFiles      = totalFiles

    if (await maybeStop()) return

    // CRITICAL budget gate — pause before generating each new file.
    // Returns immediately if already waiting at the gate (client polls after resolution).
    if (state.phase === 'phase3_budget_gate') return

    if (state.budgetMode === 'CRITICAL' && !state.budgetGateCleared && state.round === 1 && state.phase === 'phase3_generating') {
      const budget = await getBudgetStatus(state.userId, state.sessionId)
      const filesCompleted = state.currentFileIdx
      const estimatedFileUsd = filesCompleted > 0
        ? budget.sessionCostUsd / filesCompleted
        : 0
      emit({
        type: 'budget_gate',
        filename,
        fileIndex: state.currentFileIdx,
        totalFiles,
        spentUsd:        budget.sessionCostUsd,
        remainingUsd:    budget.totalRemainingUsd,
        estimatedFileUsd,
      })
      state = await transition(state, 'phase3_budget_gate')
      return
    }

    // ── 3a: Generate ──────────────────────────────────────────────────────

    if (state.phase === 'phase3_generating') {
      try {
        const genResult = await runPhase3Generate(
          projectId, sessionId, filename, state.currentFileIdx,
          totalFiles, state.fileManifest!, state.spec!, coderAdapter,
          state.acceptedFiles, emit, state.contextText,
          // regenHint was captured before resetPerFileState cleared r1Hunks/compilerErrors
          state.regenAttempted ? state.regenHint : undefined,
        )
        state.currentFileCode = genResult.code
        recordAndRefreshBudget(
          state, config.coderProvider, config.coderModelId,
          genResult.tokensIn, genResult.tokensOut, emit,
          genResult.cacheReadTokens, genResult.cacheWriteTokens,
        )
        state = await transition(state, 'phase3_reviewing')
      } catch (err) {
        await handleError(state, err, emit)
        return
      }
    }

    // ── 3b: R1 + R2 review in parallel ────────────────────────────────────
    // Round 1 → full initial review.
    // Round > 1 → re-review mode: FIXED/NOT_FIXED verdicts + new HIGH only.

    if (state.phase === 'phase3_reviewing') {
      try {
        const codeToReview = state.patchedCode ?? state.currentFileCode!
        const { r1, r2 } = await runPhase3Review(
          projectId, sessionId, filename, codeToReview,
          state.spec!, state.fileManifest!, state.round,
          r1Adapter, r2Adapter, emit,
          state.previousHunkRecords,
          state.compilerErrors,
          state.budgetMode,
        )
        state.r1Hunks = r1
        state.r2Hunks = r2

        const highHunks = [...r1, ...r2].filter(isActionable)
        if (highHunks.length === 0) {
          await acceptCurrentFile(codeToReview)
          if (await advanceToNextFile()) continue
          return
        }

        const { resolved, conflicts } = mergeReviewHunks(
          r1.filter(isActionable),
          r2.filter(isActionable),
          { [filename]: codeToReview },
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

    // ── 3d: Deterministic patch apply + compiler verify ───────────────────

    if (state.phase === 'phase3_patching') {
      try {
        // Bug fix: round 2+ must patch against the previously-patched code,
        // not the original generated code — reviewers' anchors reference patchedCode.
        const baseCode = state.patchedCode ?? state.currentFileCode!
        const patchedCode = await runPhase3Patch(
          projectId, sessionId, filename,
          baseCode, state.resolvedHunks!,
          coderAdapter, emit,
        )
        state.patchedCode = patchedCode

        // Build previousHunkRecords BEFORE resetPerFileState wipes r1/r2Hunks
        state.previousHunkRecords = buildPreviousHunkRecords(
          state.resolvedHunks ?? [],
          state.r1Hunks       ?? [],
          state.r2Hunks       ?? [],
        )

        // Compiler gate — runs before the next review round
        const verify = await verifyFile(filename, patchedCode, state.acceptedFiles)
        emit({ type: 'verify_result', filename, ok: verify.ok, errors: verify.errors })
        state.compilerErrors = verify.ok ? undefined : verify.errors

        // Check round cap — EFFICIENT mode caps at 2 rounds to reduce reviewer cost
        const maxRounds = state.budgetMode === 'EFFICIENT' ? 2 : 3
        if (state.round >= maxRounds && !state.regenAttempted) {
          // One regeneration attempt before going to arbitration.
          // IMPORTANT: build the hint before resetPerFileState wipes r1/r2Hunks and
          // compilerErrors, then set regenAttempted=true AFTER the reset so it isn't
          // overwritten back to false.
          dbg.orch('round cap reached — trying one regen before arbitration', { round: state.round, filename })
          const hint = buildRegenHint(state.r1Hunks ?? [], state.r2Hunks ?? [], state.compilerErrors)
          resetPerFileState(state)           // clears regenAttempted → false
          state.regenAttempted = true        // must be set AFTER reset
          state.regenHint      = hint        // preserved through the regen generate call
          state.round = maxRounds
          state = await transition(state, 'phase3_generating')
        } else if (state.round >= maxRounds && state.regenAttempted) {
          // Already tried regeneration — go to arbitration
          const highRemaining = [
            ...(state.r1Hunks ?? []).filter(isActionable).map(h => ({ ...h, source: 'R1' as const })),
            ...(state.r2Hunks ?? []).filter(isActionable).map(h => ({ ...h, source: 'R2' as const })),
          ]
          const pkg: ArbitrationPackage = {
            filename,
            round:            state.round,
            unresolved_hunks: highRemaining,
            r1_summary:       `R1 flagged ${(state.r1Hunks ?? []).filter(isActionable).length} issues`,
            r2_summary:       `R2 flagged ${(state.r2Hunks ?? []).filter(isActionable).length} issues`,
          }
          state.arbitrationPkg = pkg
          emit({ type: 'arbitration', pkg })
          state = await transition(state, 'phase3_arbitration')
          return
        } else {
          // Advance to the next round's review (collapses the old re_review step)
          state.round += 1
          state = await transition(state, 'phase3_reviewing')
        }
      } catch (err) {
        await handleError(state, err, emit)
        return
      }
    }

    // phase3_re_review is kept in the PipelinePhase enum for UI/reconnect compat
    // but is no longer entered from the happy-path loop — the patch step transitions
    // directly to phase3_reviewing (next round).
    if (state.phase === 'phase3_re_review') {
      state = await transition(state, 'phase3_reviewing')
    }

    if (state.phase === 'phase3_arbitration') return
  }

    if (state.phase === 'output_gate') return
  } finally {
    // Release run-lock and clear subscribers — executes on any exit path (return, throw, gate)
    runningStore.delete(sessionId)
    subscriberStore.delete(sessionId)
  }
}

// ─── Actionable hunk predicate ────────────────────────────────────────────────
// Excludes placeholder hunks produced by parseReReviewResponse when a model
// omits a verdict or says NOT_FIXED without providing a fix. These carry no
// applicable replacement and must not stall the convergence check.

function isActionable(h: ReviewHunk): boolean {
  return h.severity === 'HIGH' && h.filename !== 'unknown' && h.fixed_code.trim() !== ''
}

// ─── Regeneration hint builder ────────────────────────────────────────────────

function buildRegenHint(
  r1Hunks:        ReviewHunk[],
  r2Hunks:        ReviewHunk[],
  compilerErrors: string[] | undefined,
): string {
  const parts: string[] = []
  if (compilerErrors?.length) {
    parts.push('COMPILER ERRORS (must fix):')
    compilerErrors.forEach(e => parts.push(`  - ${e}`))
  }
  const highIssues = [...r1Hunks, ...r2Hunks].filter(h => h.severity === 'HIGH')
  if (highIssues.length > 0) {
    parts.push('KNOWN HIGH-SEVERITY ISSUES (must avoid):')
    highIssues.forEach(h => parts.push(`  - ${h.issue}`))
  }
  return parts.join('\n')
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
