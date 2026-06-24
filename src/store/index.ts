'use client'

import { createContext, createElement, useContext, useReducer, type Dispatch, type ReactNode } from 'react'
import type {
  AlignmentMessage,
  BudgetStatus,
  CoderVerification,
  ConsensusOutput,
  Contradiction,
  DialogueMessage,
  DialogueSummary,
  PipelinePhase,
  Question,
  ReviewEdit,
  ReviewPayload,
  SelfCheckOutput,
  SpecDocument,
  ThinkingOutput,
} from '@/types'

// ─── State ────────────────────────────────────────────────────────────────────

export interface ProjectConfig {
  id:               string
  name:             string
  primaryProvider:  string
  primaryModelId:   string
  reviewerProvider: string
  reviewerModelId:  string
}

export interface PipelineState {
  // Session
  project:          ProjectConfig | null
  sessionId:        string | null

  // Phase tracking
  phase:            PipelinePhase
  round:            number

  // Phase 1: Thinking
  thinkingPrimary:  ThinkingOutput | null
  thinkingReviewer: ThinkingOutput | null

  // Phase 1.5: Alignment
  alignmentMessages: AlignmentMessage[]

  // Phase 2: Questions + Spec
  questions:        Question[]
  userAnswers:      Record<string, string>
  contradiction:    Contradiction | null
  spec:             SpecDocument | null

  // Phase 3: Generation
  streamingCode:    string
  selfCheckOutput:  SelfCheckOutput | null
  lastReview:       ReviewPayload | null

  // Phase 3b: Reviewer edit + coder verify + dialogue
  reviewerEdit:     ReviewEdit | null
  coderVerification: CoderVerification | null
  dialogue:         DialogueSummary | null

  // Output (consensus-validated)
  output:           ConsensusOutput | null

  // Conflict escalation
  conflictReason:   string | null

  // UI state
  isStreaming:      boolean
  budget:           BudgetStatus | null
  error:            string | null
}

const initialState: PipelineState = {
  project:           null,
  sessionId:         null,
  phase:             'idle',
  round:             1,
  thinkingPrimary:   null,
  thinkingReviewer:  null,
  alignmentMessages: [],
  questions:         [],
  userAnswers:       {},
  contradiction:     null,
  spec:              null,
  streamingCode:     '',
  selfCheckOutput:   null,
  lastReview:        null,
  reviewerEdit:      null,
  coderVerification: null,
  dialogue:          null,
  output:            null,
  conflictReason:    null,
  isStreaming:       false,
  budget:            null,
  error:             null,
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export type PipelineAction =
  | { type: 'SET_PROJECT';        project: ProjectConfig }
  | { type: 'START_SESSION';      sessionId: string }
  | { type: 'SET_PHASE';          phase: PipelinePhase; round?: number }
  | { type: 'THINKING_DONE';      actor: 'primary' | 'reviewer'; output: ThinkingOutput }
  | { type: 'ALIGNMENT_MSG';      message: AlignmentMessage }
  | { type: 'QUESTIONS_READY';    questions: Question[] }
  | { type: 'ANSWER_QUESTION';    questionId: string; optionId: string }
  | { type: 'SET_CONTRADICTION';  contradiction: Contradiction }
  | { type: 'CLEAR_CONTRADICTION' }
  | { type: 'SPEC_READY';         spec: SpecDocument }
  | { type: 'TOKEN';              text: string }
  | { type: 'SELF_CHECK_DONE';    output: SelfCheckOutput }
  | { type: 'REVIEW_DONE';        review: ReviewPayload }
  | { type: 'CONSENSUS';          output: ConsensusOutput }
  | { type: 'CONFLICT_ESCALATED'; review: ReviewPayload; round: number; reason: string }
  | { type: 'REVIEWER_EDIT_DONE'; edit: ReviewEdit }
  | { type: 'CODER_VERIFY_DONE';  verification: CoderVerification }
  | { type: 'DIALOGUE_MSG';       message: DialogueMessage }
  | { type: 'DIALOGUE_RESOLVED';  mergedCode: string }
  | { type: 'DIALOGUE_ESCALATED'; summary: DialogueSummary }
  | { type: 'SET_STREAMING';      value: boolean }
  | { type: 'SET_BUDGET';         budget: BudgetStatus }
  | { type: 'SET_ERROR';          error: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'RESET_SESSION' }
  | { type: 'CLEAR_PROJECT' }
  // Restores a previously saved session from local filesystem
  | { type: 'RESTORE_SESSION';    output: ConsensusOutput; spec: SpecDocument | null }

// ─── Reducer ──────────────────────────────────────────────────────────────────

function reducer(state: PipelineState, action: PipelineAction): PipelineState {
  switch (action.type) {
    case 'SET_PROJECT':
      return { ...state, project: action.project }

    case 'START_SESSION':
      return {
        ...initialState,
        project:    state.project,
        budget:     state.budget,
        sessionId:  action.sessionId,
        phase:      'phase1_thinking',
        isStreaming: true,
      }

    case 'SET_PHASE':
      return {
        ...state,
        phase: action.phase,
        round: action.round ?? state.round,
        // Reset the code buffer at the start of every generation round so
        // round 2+ tokens are never appended to round 1's output.
        streamingCode: action.phase === 'phase3_generating' ? '' : state.streamingCode,
        // Preserve the error message when landing on the error phase — clearing it
        // here would hide the error banner and make the UI look like a silent reset.
        error: action.phase === 'error' ? state.error : null,
      }

    case 'THINKING_DONE':
      return action.actor === 'primary'
        ? { ...state, thinkingPrimary:  action.output }
        : { ...state, thinkingReviewer: action.output }

    case 'ALIGNMENT_MSG':
      return { ...state, alignmentMessages: [...state.alignmentMessages, action.message] }

    case 'QUESTIONS_READY':
      return { ...state, questions: action.questions, userAnswers: {} }

    case 'ANSWER_QUESTION':
      return { ...state, userAnswers: { ...state.userAnswers, [action.questionId]: action.optionId } }

    case 'SET_CONTRADICTION':
      return { ...state, contradiction: action.contradiction }

    case 'CLEAR_CONTRADICTION':
      return { ...state, contradiction: null }

    case 'SPEC_READY':
      return { ...state, spec: action.spec }

    case 'TOKEN':
      return { ...state, streamingCode: state.streamingCode + action.text }

    case 'SELF_CHECK_DONE':
      return { ...state, selfCheckOutput: action.output }

    case 'REVIEW_DONE':
      return { ...state, lastReview: action.review }

    case 'CONSENSUS':
      return { ...state, output: action.output, phase: 'complete', isStreaming: false }

    case 'CONFLICT_ESCALATED':
      return {
        ...state,
        lastReview:    action.review,
        round:         action.round,
        conflictReason: action.reason,
        phase:         'conflict_escalated',
        isStreaming:   false,
      }

    case 'REVIEWER_EDIT_DONE':
      return { ...state, reviewerEdit: action.edit }

    case 'CODER_VERIFY_DONE':
      return { ...state, coderVerification: action.verification }

    case 'DIALOGUE_MSG':
      return {
        ...state,
        dialogue: state.dialogue
          ? { ...state.dialogue, messages: [...state.dialogue.messages, action.message], rounds: action.message.round }
          : { messages: [action.message], rounds: action.message.round, resolved: false, coderFinalPosition: '', reviewerFinalPosition: '' },
      }

    case 'DIALOGUE_RESOLVED':
      return {
        ...state,
        dialogue: state.dialogue ? { ...state.dialogue, resolved: true } : null,
        streamingCode: action.mergedCode,
      }

    case 'DIALOGUE_ESCALATED':
      return {
        ...state,
        dialogue:      action.summary,
        phase:         'conflict_escalated',
        isStreaming:   false,
      }

    case 'SET_STREAMING':
      return { ...state, isStreaming: action.value }

    case 'SET_BUDGET':
      return { ...state, budget: action.budget }

    case 'SET_ERROR':
      return { ...state, error: action.error, isStreaming: false, phase: 'error' }

    case 'CLEAR_ERROR':
      return { ...state, error: null }

    case 'RESET_SESSION':
      return { ...initialState, project: state.project, budget: state.budget }

    case 'CLEAR_PROJECT':
      return { ...initialState, budget: state.budget }

    case 'RESTORE_SESSION':
      return {
        ...initialState,
        project:     state.project,
        budget:      state.budget,
        phase:       'complete',
        output:      action.output,
        spec:        action.spec,
        isStreaming: false,
      }

    default:
      return state
  }
}

// ─── Context ──────────────────────────────────────────────────────────────────

const StateContext    = createContext<PipelineState>(initialState)
const DispatchContext = createContext<Dispatch<PipelineAction>>(() => undefined)

export function PipelineProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  return createElement(
    StateContext.Provider, { value: state },
    createElement(DispatchContext.Provider, { value: dispatch }, children),
  )
}

export function usePipelineState()    { return useContext(StateContext) }
export function usePipelineDispatch() { return useContext(DispatchContext) }

