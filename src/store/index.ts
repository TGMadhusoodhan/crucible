'use client'

import { createContext, createElement, useContext, useEffect, useReducer, type Dispatch, type ReactNode } from 'react'
import type {
  AlignmentMessage,
  ArbitrationPackage,
  BudgetStatus,
  ConsensusOutput,
  Contradiction,
  CrossReviewResponse,
  FileManifest,
  HunkConflict,
  PipelinePhase,
  Question,
  ResolvedHunk,
  ReviewHunk,
  SpecDocument,
  ThinkingOutput,
} from '@/types'

// ─── State ────────────────────────────────────────────────────────────────────

export interface ProjectConfig {
  id:            string
  name:          string
  coderProvider: 'deepseek'
  coderModelId:  'deepseek-v4-pro'
  r1Provider:    string
  r1ModelId:     string
  r2Provider:    string
  r2ModelId:     string
}

export interface PipelineState {
  // Session
  project:           ProjectConfig | null
  sessionId:         string | null

  // Phase tracking
  phase:             PipelinePhase
  round:             number

  // Per-file loop tracking
  currentFileIdx:    number
  currentFilename:   string | null
  totalFiles:        number

  // Phase 1: Thinking
  thinkingR1:        ThinkingOutput | null
  thinkingR2:        ThinkingOutput | null

  // Phase 1.5: Alignment
  alignmentMessages: AlignmentMessage[]

  // Phase 2: Questions + Spec + Manifest
  questions:         Question[]
  userAnswers:       Record<string, string>
  contradiction:     Contradiction | null
  spec:              SpecDocument | null
  fileManifest:      FileManifest | null

  // Phase 3: per-file generation + dual review
  streamingCode:     string
  currentFileCode:   string | null
  r1Hunks:           ReviewHunk[]
  r2Hunks:           ReviewHunk[]
  conflicts:         HunkConflict[]
  resolvedHunks:     ResolvedHunk[]
  patchedCode:       string | null
  arbitrationPkg:    ArbitrationPackage | null
  // conflict_id → each side's cross-review verdict, so CrossReviewPanel can
  // show live pending/resolved status instead of a static "resolving" state.
  crossReviewResponses: Record<string, { r1?: CrossReviewResponse; r2?: CrossReviewResponse }>

  // Accepted files (output gate)
  acceptedFiles:     Record<string, string>

  // Output (consensus-validated)
  output:            ConsensusOutput | null

  // GitHub push status (per_file mode — populated via SSE; per_session via API response)
  githubPush?:       { sha: string; branch: string; url: string } | { error: string }

  // UI state
  isStreaming:       boolean
  budget:            BudgetStatus | null
  error:             string | null
}

const initialState: PipelineState = {
  project:           null,
  sessionId:         null,
  phase:             'idle',
  round:             1,
  currentFileIdx:    0,
  currentFilename:   null,
  totalFiles:        0,
  thinkingR1:        null,
  thinkingR2:        null,
  alignmentMessages: [],
  questions:         [],
  userAnswers:       {},
  contradiction:     null,
  spec:              null,
  fileManifest:      null,
  streamingCode:     '',
  currentFileCode:   null,
  r1Hunks:           [],
  r2Hunks:           [],
  conflicts:         [],
  resolvedHunks:     [],
  patchedCode:       null,
  arbitrationPkg:    null,
  crossReviewResponses: {},
  acceptedFiles:     {},
  output:            null,
  isStreaming:       false,
  budget:            null,
  error:             null,
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export type PipelineAction =
  | { type: 'START_SESSION';          sessionId: string; project: ProjectConfig }
  | { type: 'SET_PHASE';              phase: PipelinePhase }
  | { type: 'SET_ROUND';              round: number }
  | { type: 'THINKING_DONE';          actor: 'r1' | 'r2'; output: ThinkingOutput }
  | { type: 'ALIGNMENT_MSG';          message: AlignmentMessage }
  | { type: 'QUESTIONS_READY';        questions: Question[] }
  | { type: 'SET_ANSWER';             questionId: string; answer: string }
  | { type: 'CONTRADICTION';          contradiction: Contradiction }
  | { type: 'SPEC_READY';             spec: SpecDocument }
  | { type: 'MANIFEST_READY';         manifest: FileManifest }
  | { type: 'FILE_GENERATING';        filename: string; fileIndex: number; totalFiles: number }
  | { type: 'TOKEN';                  text: string }
  | { type: 'STREAM_START' }
  | { type: 'STREAM_END' }
  | { type: 'FILE_GENERATED';         filename: string; code: string }
  | { type: 'REVIEW_HUNKS';           actor: 'r1' | 'r2'; hunks: ReviewHunk[] }
  | { type: 'HUNKS_MERGED';           resolved: ResolvedHunk[]; conflicts: HunkConflict[] }
  | { type: 'CROSS_REVIEW_RESPONSE';  actor: 'r1' | 'r2'; response: CrossReviewResponse }
  | { type: 'CONFLICTS_RESOLVED';     resolved: ResolvedHunk[] }
  | { type: 'MICRO_GATE';             conflict: HunkConflict }
  | { type: 'FILE_PATCHED';           filename: string; code: string }
  | { type: 'RE_REVIEW_HUNKS';        actor: 'r1' | 'r2'; hunks: ReviewHunk[] }
  | { type: 'FILE_ACCEPTED';          filename: string; code: string }
  | { type: 'ARBITRATION';            pkg: ArbitrationPackage }
  | { type: 'OUTPUT_GATE_READY';      files: Record<string, string> }
  | { type: 'CONSENSUS';              output: ConsensusOutput }
  | { type: 'BUDGET_UPDATE';          budget: BudgetStatus }
  | { type: 'SET_ERROR';              message: string }
  | { type: 'SELECT_PROJECT';         project: ProjectConfig | null }
  | { type: 'RESTORE_OUTPUT';         output: ConsensusOutput; spec: SpecDocument | null }
  | { type: 'CLEAR_PROJECT' }
  | { type: 'RESET_SESSION' }
  | { type: 'GITHUB_PUSH_SUCCESS';    sha: string; branch: string; url: string }
  | { type: 'GITHUB_PUSH_FAILED';     message: string }

// ─── Reducer ──────────────────────────────────────────────────────────────────

function reducer(state: PipelineState, action: PipelineAction): PipelineState {
  switch (action.type) {
    case 'START_SESSION':
      return {
        ...initialState,
        project:   action.project,
        sessionId: action.sessionId,
        budget:    state.budget,
      }

    case 'SET_PHASE':
      return { ...state, phase: action.phase }

    case 'SET_ROUND':
      return { ...state, round: action.round }

    case 'THINKING_DONE':
      return action.actor === 'r1'
        ? { ...state, thinkingR1: action.output }
        : { ...state, thinkingR2: action.output }

    case 'ALIGNMENT_MSG':
      return { ...state, alignmentMessages: [...state.alignmentMessages, action.message] }

    case 'QUESTIONS_READY':
      return { ...state, questions: action.questions, userAnswers: {} }

    case 'SET_ANSWER':
      return { ...state, userAnswers: { ...state.userAnswers, [action.questionId]: action.answer } }

    case 'CONTRADICTION':
      return { ...state, contradiction: action.contradiction }

    case 'SPEC_READY':
      return { ...state, spec: action.spec }

    case 'MANIFEST_READY':
      return { ...state, fileManifest: action.manifest }

    case 'FILE_GENERATING':
      return {
        ...state,
        currentFilename: action.filename,
        currentFileIdx:  action.fileIndex,
        totalFiles:      action.totalFiles,
        streamingCode:   '',
      }

    case 'TOKEN':
      return { ...state, streamingCode: state.streamingCode + action.text }

    case 'STREAM_START':
      return { ...state, isStreaming: true }

    case 'STREAM_END':
      return { ...state, isStreaming: false }

    case 'FILE_GENERATED':
      return { ...state, currentFileCode: action.code }

    case 'REVIEW_HUNKS':
      return action.actor === 'r1'
        ? { ...state, r1Hunks: action.hunks }
        : { ...state, r2Hunks: action.hunks }

    case 'HUNKS_MERGED':
      return {
        ...state,
        resolvedHunks: action.resolved,
        conflicts:     action.conflicts,
        crossReviewResponses: {},
      }

    case 'CROSS_REVIEW_RESPONSE': {
      const conflictId = action.response.conflict_id
      const existing    = state.crossReviewResponses[conflictId] ?? {}
      return {
        ...state,
        crossReviewResponses: {
          ...state.crossReviewResponses,
          [conflictId]: { ...existing, [action.actor]: action.response },
        },
      }
    }

    case 'CONFLICTS_RESOLVED':
      return { ...state, resolvedHunks: action.resolved, conflicts: [] }

    case 'MICRO_GATE':
      // The conflict is already present in state.conflicts from HUNKS_MERGED;
      // this event only signals which one is currently gating on the human.
      return state

    case 'FILE_PATCHED':
      return { ...state, patchedCode: action.code }

    case 'RE_REVIEW_HUNKS':
      return action.actor === 'r1'
        ? { ...state, r1Hunks: action.hunks }
        : { ...state, r2Hunks: action.hunks }

    case 'FILE_ACCEPTED':
      return {
        ...state,
        acceptedFiles:  { ...state.acceptedFiles, [action.filename]: action.code },
        currentFileCode: null,
        r1Hunks:         [],
        r2Hunks:         [],
        conflicts:       [],
        resolvedHunks:   [],
        patchedCode:     null,
        arbitrationPkg:  null,
        streamingCode:   '',
        crossReviewResponses: {},
      }

    case 'ARBITRATION':
      return { ...state, arbitrationPkg: action.pkg }

    case 'OUTPUT_GATE_READY':
      // Current file's code is already tracked via patchedCode/currentFileCode;
      // no dedicated slot for the raw files payload.
      return state

    case 'CONSENSUS':
      return { ...state, output: action.output }

    case 'RESTORE_OUTPUT':
      // Reopening a project that already finished a previous session —
      // show its accepted files directly instead of an empty task-input screen.
      return {
        ...state,
        output:        action.output,
        spec:          action.spec ?? state.spec,
        acceptedFiles: action.output.files,
        phase:         'complete',
      }

    case 'BUDGET_UPDATE':
      return { ...state, budget: action.budget }

    case 'SET_ERROR':
      return { ...state, error: action.message, isStreaming: false, phase: 'error' }

    case 'SELECT_PROJECT':
      // Selecting a different project resets any in-progress pipeline state —
      // matches CLEAR_PROJECT/RESET_SESSION's pattern of preserving only budget.
      return { ...initialState, project: action.project, budget: state.budget }

    case 'CLEAR_PROJECT':
      return { ...initialState, budget: state.budget }

    case 'RESET_SESSION':
      return { ...initialState, budget: state.budget }

    case 'GITHUB_PUSH_SUCCESS':
      return { ...state, githubPush: { sha: action.sha, branch: action.branch, url: action.url } }

    case 'GITHUB_PUSH_FAILED':
      return { ...state, githubPush: { error: action.message } }

    default:
      return state
  }
}

// ─── Context ──────────────────────────────────────────────────────────────────

const StateContext    = createContext<PipelineState>(initialState)
const DispatchContext = createContext<Dispatch<PipelineAction>>(() => undefined)

export function PipelineProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)

  // Expose dispatch globally in dev so test tooling can inject fake sessions
  // without going through the full pipeline API.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      ;(window as unknown as Record<string, unknown>).__pipelineDispatch = dispatch
    }
    return () => {
      if (process.env.NODE_ENV !== 'production') {
        delete (window as unknown as Record<string, unknown>).__pipelineDispatch
      }
    }
  }, [dispatch])

  return createElement(
    StateContext.Provider, { value: state },
    createElement(DispatchContext.Provider, { value: dispatch }, children),
  )
}

export function usePipelineState()    { return useContext(StateContext) }
export function usePipelineDispatch() { return useContext(DispatchContext) }
