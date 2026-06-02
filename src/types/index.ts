import { z } from 'zod'

// ─── Primitives ───────────────────────────────────────────────────────────────

export type Provider =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'google'
  | 'mistral'
  | 'openrouter'
  | 'groq'
  | 'together'

export type Plan = 'free' | 'indie' | 'pro' | 'team'

export type BudgetMode = 'FULL' | 'EFFICIENT' | 'CONSERVATION' | 'CRITICAL'

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ─── Phase 0 — Context ────────────────────────────────────────────────────────

export interface ContextInput {
  text?: string        // pasted code or description
  files?: string[]     // file paths relative to project root (File System Access API)
}

// ─── Phase 1 — Thinking ───────────────────────────────────────────────────────

export type AssumptionCategory =
  | 'architecture'
  | 'security'
  | 'performance'
  | 'behavior'
  | 'other'

export interface Assumption {
  id: string
  description: string
  category: AssumptionCategory
  confidence: 'high' | 'medium' | 'low'
}

export type QuestionCategory =
  | 'core_behavior'
  | 'security'
  | 'error_handling'
  | 'edge_cases'
  | 'integration'

export interface QuestionOption {
  id: string
  label: string
  description: string
  tradeoffs?: string
}

export interface Question {
  id: string
  text: string
  category: QuestionCategory
  source: 'primary' | 'reviewer' | 'alignment' | 'second_pass'
  options: QuestionOption[]
  recommended_option_id?: string
  recommendation_reason: string  // always non-empty per architecture rules
  is_required: boolean
}

export interface ThinkingOutput {
  understood_as: string
  assumptions: Assumption[]
  questions: Question[]
  recommended_approach: string
  risks: string[]
  provider: Provider
  model_id: string
  tokens_used: number
}

// Zod schema for runtime validation of ThinkingOutput from model
export const thinkingOutputSchema = z.object({
  understood_as:        z.string().min(1).catch('unknown'),
  assumptions:          z.array(z.object({
    id:          z.string().catch(''),
    description: z.string().min(1).catch(''),
    category:    z.enum(['architecture', 'security', 'performance', 'behavior', 'other']).catch('other'),
    confidence:  z.enum(['high', 'medium', 'low']).catch('medium'),
  })).catch([]),
  questions:            z.array(z.object({
    id:                   z.string().catch(''),
    text:                 z.string().min(1).catch(''),
    category:             z.enum(['core_behavior', 'security', 'error_handling', 'edge_cases', 'integration']).catch('core_behavior'),
    source:               z.enum(['primary', 'reviewer', 'alignment', 'second_pass']).catch('primary'),
    options:              z.array(z.object({
      id:          z.string().catch(''),
      label:       z.string().min(1).catch(''),
      description: z.string().min(1).catch(''),
      tradeoffs:   z.string().optional(),
    })).catch([]),
    recommended_option_id: z.string().optional(),
    recommendation_reason: z.string().catch(''),
    is_required:           z.boolean().catch(false),
  })).catch([]),
  recommended_approach: z.string().catch(''),
  risks:                z.array(z.string()).catch([]),
})

// ─── Phase 1.5 — Alignment ───────────────────────────────────────────────────

export interface AlignmentMessage {
  id: string
  round: 1 | 2
  actor: 'primary' | 'reviewer'
  understood_as: string
  questions_summary: string[]  // key questions this model wants answered
  position: string             // model's position on architecture / approach
  timestamp: number
}

export interface AlignmentResult {
  messages: AlignmentMessage[]
  agreed_questions: Question[]        // deduplicated, merged from both models
  agreed_recommendations: string[]    // shared recommendations both models agree on
  unresolved_conflicts: string[]      // surfaced as required Phase 2 questions
  architectural_mismatch_detected: boolean
  rounds_taken: 1 | 2
  total_tokens: number
}

// ─── Phase 2 — Questions + Contradiction + Spec ───────────────────────────────

export interface Contradiction {
  id: string
  question_a_id: string
  question_b_id: string
  chosen_answer_a: string
  chosen_answer_b: string
  description: string
  resolution_options: ContradictionResolution[]
}

export interface ContradictionResolution {
  id: string
  description: string
  changes: Record<string, string>  // questionId → new answer (optionId)
}

export interface AcceptanceCriterion {
  id: string
  description: string
  test_case: string
}

export interface EdgeCase {
  id: string
  scenario: string
  expected_behavior: string
  test_case: string
}

export interface ErrorScenario {
  id: string
  trigger: string
  message: string
  recovery?: string
}

export interface SpecDocument {
  id: string
  project_id: string
  session_id: string
  created_at: string   // ISO8601
  task_description: string
  codebase_context?: string
  user_decisions:    Record<string, string>  // questionId → chosen optionId
  model_defaults:    Record<string, string>  // assumed values — never hidden
  acceptance_criteria: AcceptanceCriterion[]
  edge_cases:          EdgeCase[]
  error_messages:      ErrorScenario[]
  human_confirmed:     boolean
  confirmed_at?:       string  // ISO8601
}

// ─── Phase 3 — Generation, Self-Check, Review ────────────────────────────────

export interface SelfCheckIssue {
  severity: 'high' | 'medium' | 'low'
  description: string
  location?: string         // e.g. "line 47" or "handleLogin()"
  suggested_fix: string     // PLAIN ENGLISH only — max 3 lines, no code syntax
}

export interface SelfCheckOutput {
  pass: 1 | 2          // which pass this is (hard limit at 2)
  issues: SelfCheckIssue[]
  all_clear: boolean   // true = no issues found, can proceed to review
  reasoning: string
}

export const selfCheckOutputSchema = z.object({
  pass:      z.union([z.literal(1), z.literal(2)]).catch(1 as 1),
  issues:    z.array(z.object({
    severity:      z.enum(['high', 'medium', 'low']).catch('medium'),
    description:   z.string().min(1).catch(''),
    location:      z.string().optional(),
    suggested_fix: z.string().catch(''),
  })).catch([]),
  all_clear: z.boolean().catch(false),
  reasoning: z.string().catch(''),
})

export type ReviewFlagSeverity = 'HIGH' | 'MEDIUM' | 'LOW'
export type ReviewFlagCategory = 'bug' | 'logic' | 'security' | 'performance' | 'edge_case'

export interface ReviewFlag {
  id: string
  severity: ReviewFlagSeverity
  category: ReviewFlagCategory
  description: string
  pseudo_code_hint?: string  // plain-English only, max 3 lines — NO code syntax
  location?: string
}

export interface ReviewPayload {
  consensus: boolean
  round: number
  flags: ReviewFlag[]
  // Flat arrays derived from flags — kept for simpler rendering
  critical_bugs:     string[]   // HIGH severity bugs
  logic_errors:      string[]   // MEDIUM logic issues
  edge_cases_missed: string[]   // edge case flags
  pseudo_code_hints: string[]   // all pseudo-code hints in one list
  reasoning: string
  dependencies_rechecked: boolean  // must be true in rounds 2+
}

export const reviewPayloadSchema = z.object({
  consensus:               z.boolean().catch(false),
  round:                   z.number().int().min(1).catch(1),
  flags: z.array(z.object({
    id:               z.string().catch(''),
    severity:         z.enum(['HIGH', 'MEDIUM', 'LOW']).catch('MEDIUM'),
    category:         z.enum(['bug', 'logic', 'security', 'performance', 'edge_case']).catch('bug'),
    description:      z.string().min(1).catch(''),
    pseudo_code_hint: z.string().optional(),
    location:         z.string().optional(),
  })).catch([]),
  critical_bugs:           z.array(z.string()).catch([]),
  logic_errors:            z.array(z.string()).catch([]),
  edge_cases_missed:       z.array(z.string()).catch([]),
  pseudo_code_hints:       z.array(z.string()).catch([]),
  reasoning:               z.string().catch(''),
  dependencies_rechecked:  z.boolean().catch(false),
})

export interface ConsensusOutput {
  code: string
  review: ReviewPayload
  promoted_at: number
  checkpoint_id: string
}

// ─── Pipeline Context (passed to generate / review) ──────────────────────────

export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export interface PipelineContext {
  projectId: string
  sessionId: string
  spec: SpecDocument
  history: Message[]                // last 40k tokens of session log
  activeMemory: ActiveMemory
  contextText?: string              // Phase 0 codebase context
  humanOverrides: string[]          // pending human override messages
  taskDescription: string           // the original user request
}

// ─── Model Adapter Interface ──────────────────────────────────────────────────

export interface ModelAdapter {
  // Phase 1: independent silent thinking — returns structured JSON
  think(taskDescription: string, contextText?: string): Promise<ThinkingOutput>

  // Phase 1.5: alignment chat between models (max 2 rounds, enforced at call site)
  chat(
    round: 1 | 2,
    taskDescription: string,
    myThinking: ThinkingOutput,
    otherThinking: ThinkingOutput,
    previousMessages?: AlignmentMessage[],
    contextText?: string,
  ): Promise<AlignmentMessage>

  // Phase 3: code generation — streams tokens
  generate(prompt: string, ctx: PipelineContext): AsyncGenerator<string>

  // Phase 3: self-check of own output (max 2 passes, enforced in phase3-generate.ts)
  selfCheck(code: string, spec: SpecDocument, pass: 1 | 2, previousIssues?: SelfCheckIssue[]): Promise<SelfCheckOutput>

  // Phase 3: cross-model code review — returns structured JSON flags only
  review(code: string, spec: SpecDocument, round: number, previousReview?: ReviewPayload): Promise<ReviewPayload>

  // Metadata
  getProvider(): Provider
  getModelId(): string
  estimateCost(inputTokens: number, outputTokens: number): number
}

// ─── Pipeline State (stored in Redis) ────────────────────────────────────────

export type PipelinePhase =
  | 'idle'
  | 'phase0_context'
  | 'phase1_thinking'
  | 'phase1_5_alignment'
  | 'phase2_questions'
  | 'phase2_answering'
  | 'phase2_contradictions'
  | 'phase2_spec'
  | 'phase2_spec_confirm'
  | 'phase3_generating'
  | 'phase3_self_check'
  | 'phase3_reviewing'
  | 'phase3_consensus'
  | 'conflict_escalated'
  | 'complete'
  | 'paused'
  | 'stopped'
  | 'error'

export interface PipelineConfig {
  primaryProvider: Provider
  primaryModelId: string
  primaryApiKey: string
  reviewerProvider: Provider
  reviewerModelId: string
  reviewerApiKey: string
}

export interface PipelineSessionState {
  sessionId: string
  projectId: string
  userId: string                       // Clerk user ID — required for budget tracking
  phase: PipelinePhase
  config: PipelineConfig
  round: number                        // generation round (1–3 before escalation)
  selfCheckPass: number                // 0 | 1 | 2 — enforced ≤ 2
  taskDescription: string              // original user request
  contextText?: string                 // Phase 0 codebase context
  thinkingOutputs?: {
    primary:  ThinkingOutput
    reviewer: ThinkingOutput
  }
  alignmentResult?: AlignmentResult
  questions?: Question[]
  userAnswers?: Record<string, string> // questionId → optionId
  contradictions?: Contradiction[]
  spec?: SpecDocument
  generatedCode?: string
  selfCheckOutput?: SelfCheckOutput
  lastReview?: ReviewPayload
  output?: ConsensusOutput
  pendingHumanOverrides: string[]
  conversationHistory: Message[]
  budgetMode: BudgetMode
  createdAt: number
  updatedAt: number
}

// ─── Conversation Tab Events ──────────────────────────────────────────────────

export type ConversationEventType =
  | 'phase_start'
  | 'model_output'
  | 'alignment_message'
  | 'alignment_conflict'
  | 'question_generated'
  | 'user_answer'
  | 'spec_written'
  | 'spec_confirmed'
  | 'generation_start'
  | 'generation_output'
  | 'self_check'
  | 'review_output'
  | 'output_promoted'
  | 'checkpoint'
  | 'human_override'
  | 'conflict_escalated'
  | 'budget_mode_change'
  | 'pause'
  | 'play'
  | 'stop'

export type ConversationActor = Provider | 'human' | 'system'
export type ConversationIndicator = 'success' | 'error' | 'warning' | 'user' | 'progress'

export interface ConversationEvent {
  id: string
  sessionId: string
  timestamp: string                  // ISO8601
  type: ConversationEventType
  phase: PipelinePhase
  round?: number
  actor: ConversationActor
  summary: string                    // one-line, shown when collapsed
  fullContent?: string               // shown when expanded
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  indicator: ConversationIndicator
  isHumanOverride?: boolean
  isConflict?: boolean
  isConsensus?: boolean
  expandable: boolean
}

// ─── Memory System ────────────────────────────────────────────────────────────

export interface Decision {
  id: string
  description: string
  reason: string
  timestamp: number
}

export interface Conflict {
  id: string
  primaryPosition: string
  reviewerPosition: string
  resolvedAt?: number
  resolution?: string
}

export type FileTree = { [key: string]: string | FileTree }

export interface CompletedModule {
  name: string
  description: string
  completedAt: number
  interfaceDescription: string
}

export interface ActiveMemory {
  current_module: string
  open_questions: string[]
  file_structure: FileTree
  recent_decisions: Decision[]
  current_tech_stack: string[]
  unresolved_conflicts: Conflict[]
}

export interface ArchiveMemory {
  completed_modules: CompletedModule[]
  resolved_decisions: Decision[]
  earlier_architecture: string[]
  deprecated_approaches: string[]
}

export interface ProjectMemory {
  active: ActiveMemory
  archive: ArchiveMemory
}

export interface Checkpoint {
  id: string
  timestamp: number
  trigger: 'module_complete' | 'conflict_resolved' | 'human_confirm' | 'manual'
  summary: string
  outputSnapshot: Record<string, string>
}

// ─── Budget ───────────────────────────────────────────────────────────────────

export interface ProviderBudget {
  provider: Provider
  capUsd: number
  spentUsd: number
  remainingUsd: number
  percentUsed: number
}

export interface BudgetStatus {
  mode: BudgetMode
  providerBreakdown: ProviderBudget[]
  totalCapUsd: number
  totalSpentUsd: number
  totalRemainingUsd: number
  percentRemaining: number
  daysElapsed: number
  dailyAverageUsd: number
  projectedMonthEndUsd: number
  sessionTokens: number
  sessionCostUsd: number
  // legacy aliases
  monthlyBudgetUsd: number
  spentUsd: number
  remainingUsd: number
}

// ─── SSE Events (pipeline → client streaming) ─────────────────────────────────

export type SSEEvent =
  | { type: 'phase_change';    phase: PipelinePhase }
  | { type: 'thinking_done';   actor: 'primary' | 'reviewer'; output: ThinkingOutput }
  | { type: 'alignment_msg';   message: AlignmentMessage }
  | { type: 'questions_ready'; questions: Question[] }
  | { type: 'contradiction';   contradiction: Contradiction }
  | { type: 'spec_ready';      spec: SpecDocument }
  | { type: 'token';           text: string }
  | { type: 'self_check_done'; output: SelfCheckOutput }
  | { type: 'review_done';     review: ReviewPayload }
  | { type: 'consensus';       output: ConsensusOutput }
  | { type: 'conflict';        review: ReviewPayload; round: number }
  | { type: 'error';           message: string; phase: PipelinePhase }
  | { type: 'done' }
