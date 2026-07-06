import { z } from 'zod'

// ─── Primitives ───────────────────────────────────────────────────────────────

export type Provider =
  | 'anthropic' | 'openai' | 'deepseek' | 'google'
  | 'mistral'   | 'openrouter' | 'groq'  | 'together' | 'zai'

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

// ─── File Manifest ────────────────────────────────────────────────────────────

export interface FileDefinition {
  filename:  string
  purpose:   string
  exports:   string[]
  imports:   Record<string, string[]>
}

export interface FileManifest {
  mode:             'single' | 'multi'
  files:            FileDefinition[]
  generation_order: string[]
  reasoning:        string
}

export const fileManifestSchema = z.object({
  mode:             z.enum(['single', 'multi']).catch('single'),
  files:            z.array(z.object({
    filename: z.string().min(1).catch('output.ts'),
    purpose:  z.string().catch(''),
    exports:  z.array(z.string()).catch([]),
    imports:  z.record(z.string(), z.array(z.string())).catch({}),
  })).catch([]),
  generation_order: z.array(z.string()).catch([]),
  reasoning:        z.string().catch(''),
})

// ─── Review Hunk ──────────────────────────────────────────────────────────────
// A reviewer's flag PLUS their drop-in code fix.
// Reviewers always provide both — never a flag without a fix.

export type ReviewFlagCategory =
  | 'logic' | 'security' | 'performance' | 'correctness'
  | 'missing_implementation' | 'edge_case' | 'contract_violation'

export interface ReviewHunk {
  id:             string
  filename:       string
  line_start:     number   // display hint only — approximate line
  line_end:       number   // display hint only — approximate line
  severity:       'HIGH' | 'MEDIUM' | 'LOW'
  issue:          string        // what is wrong
  original_code?: string        // verbatim text to replace (anchor for deterministic apply)
  fixed_code:     string        // replacement — same scope as original_code
  category:       ReviewFlagCategory
  source?:        'R1' | 'R2' | 'both'
  confirmed?:     boolean
}

export const reviewHunkSchema = z.object({
  id:            z.string().catch(() => `h_${Math.random().toString(36).slice(2,8)}`),
  filename:      z.string().min(1).catch('unknown'),
  line_start:    z.number().int().min(1).catch(1),
  line_end:      z.number().int().min(1).catch(1),
  severity:      z.enum(['HIGH', 'MEDIUM', 'LOW']).catch('MEDIUM'),
  issue:         z.string().catch(''),
  original_code: z.string().catch(''),
  fixed_code:    z.string().catch(''),
  category:      z.enum([
    'logic','security','performance','correctness',
    'missing_implementation','edge_case','contract_violation',
  ]).catch('logic'),
})

export const reviewHunksSchema = z.array(reviewHunkSchema).catch([])

// ─── Re-review response — { verdicts, new_issues } ───────────────────────────
// Used by parseWithRepair to validate the round > 1 re-review response structure.

export const reReviewResponseSchema = z.object({
  verdicts: z.array(z.object({
    id:     z.string().catch(''),
    status: z.enum(['FIXED', 'NOT_FIXED']),         // STRICT
    hunk:   reviewHunkSchema.optional(),
  })).catch([]),
  new_issues: z.array(reviewHunkSchema).catch([]),
})

// ─── Previous Hunk Record — passed to re-review so models can issue verdicts ─

export interface PreviousHunkRecord {
  id:            string
  issue:         string
  original_code: string   // text that was there before the fix
  fixed_code:    string   // what was applied
}

// ─── Re-review verdict ────────────────────────────────────────────────────────

export interface HunkVerdict {
  id:    string
  status: 'FIXED' | 'NOT_FIXED'
  hunk?: ReviewHunk   // only when NOT_FIXED
}

// ─── Hunk Conflict ────────────────────────────────────────────────────────────

export interface HunkConflict {
  id:            string
  filename:      string
  line_start:    number
  line_end:      number
  r1_hunk:       ReviewHunk
  r2_hunk:       ReviewHunk
  original_code: string
}

// ─── Cross-review Response ────────────────────────────────────────────────────

export type CrossReviewDecision = 'ACCEPT_THEIRS' | 'KEEP_MINE' | 'NEW_FIX'

export interface CrossReviewResponse {
  conflict_id: string
  decision:    CrossReviewDecision
  new_code?:   string
  reason:      string
}

export const crossReviewResponseSchema = z.object({
  conflict_id: z.string().catch(''),
  decision:    z.enum(['ACCEPT_THEIRS', 'KEEP_MINE', 'NEW_FIX']).catch('KEEP_MINE'),
  new_code:    z.string().optional(),
  reason:      z.string().catch(''),
})

// ─── Resolved Hunk ────────────────────────────────────────────────────────────

export interface ResolvedHunk {
  filename:       string
  line_start:     number
  line_end:       number
  original_code?: string   // verbatim text that was replaced (for anchor-based apply)
  new_code:       string
  source:         'R1' | 'R2' | 'both' | 'cross_review' | 'human'
  flag_ids:       string[]
}

// ─── Arbitration ──────────────────────────────────────────────────────────────

export interface ArbitrationPackage {
  filename:         string
  round:            number
  unresolved_hunks: ReviewHunk[]
  r1_summary:       string
  r2_summary:       string
}

// ─── Hunk Merge Result ────────────────────────────────────────────────────────

export interface HunkMergeResult {
  resolved:  ResolvedHunk[]
  conflicts: HunkConflict[]
}

// ─── Phase 3 — Consensus Output ───────────────────────────────────────────────

export interface ConsensusOutput {
  code: string                        // raw AI response (may contain file delimiters)
  files: Record<string, string>       // parsed multi-file map (filename → content)
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
    taskDescription: string,
    otherThinking:   ThinkingOutput,
    myThinking:      ThinkingOutput,
    round:           1 | 2,
  ): Promise<AlignmentMessage>

  // Phase 2: R1/R2 jointly propose the spec + file manifest
  proposeSpecAndManifest(
    taskDescription: string,
    questions:       Question[],
    answers:         Record<string, string>,
    contextText?:    string,
  ): Promise<{ spec: SpecDocument; manifest: FileManifest }>

  // Phase 3: DeepSeek generates the current file — streams tokens
  generate(
    filename:           string,
    fileDef:            FileDefinition,
    manifest:           FileManifest,
    spec:               SpecDocument,
    generatedSoFar:     Record<string, string>,
    contextText:        string | undefined,
    onToken:            (token: string) => void,
    regenerationHint?:  string,
  ): Promise<{ code: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; cacheWriteTokens: number }>

  // Phase 3: R1/R2 review the generated file and produce anchor-based fix hunks.
  // Round 1: full initial review.
  // Round > 1: re-review — returns NOT_FIXED hunks + new HIGH issues only.
  reviewAndPatch(
    filename:              string,
    code:                  string,
    spec:                  SpecDocument,
    manifest:              FileManifest,
    round:                 number,
    previousHunkRecords?:  PreviousHunkRecord[],
    compilerErrors?:       string[],
    options?:              { highSeverityOnly?: boolean },
  ): Promise<{ hunks: ReviewHunk[]; droppedCount: number }>

  // Phase 3: cross-review — evaluate the other reviewer's conflicting hunk
  crossReview(
    conflict:   HunkConflict,
    myHunk:     ReviewHunk,
    theirHunk:  ReviewHunk,
  ): Promise<CrossReviewResponse>

  // Phase 3: DeepSeek mechanically applies reviewer-decided patches to a file —
  // no judgment, no improvisation, just apply the exact new_code at the exact lines.
  applyPatch(
    filename:     string,
    originalCode: string,
    hunks:        ResolvedHunk[],
    onToken:      (token: string) => void,
  ): Promise<{ code: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; cacheWriteTokens: number }>

  // Output gate: human requests an ad-hoc free-text fix to an already-finalized file
  fixFile(
    filename:    string,
    code:        string,
    instruction: string,
    onToken:     (token: string) => void,
  ): Promise<{ code: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; cacheWriteTokens: number }>

  // Wire SSE retry notifications (called once by the orchestrator after adapter creation)
  setRetryEmitter(fn: (attempt: number, delayMs: number) => void): void

  // Metadata
  getProvider(): Provider
  getModelId(): string
  estimateCost(inputTokens: number, outputTokens: number): number
}

// ─── Pipeline State ───────────────────────────────────────────────────────────

export type PipelinePhase =
  | 'idle'
  | 'phase0_context'
  | 'phase1_thinking'
  | 'phase1_5_alignment'
  | 'phase2_questions'
  | 'phase2_answering'           // HUMAN GATE 1
  | 'phase2_contradiction_check'
  | 'phase2_spec_and_manifest'   // R1+R2 propose spec + file manifest
  | 'phase2_confirm'             // HUMAN GATE 2
  | 'phase3_generating'          // DeepSeek generates current file
  | 'phase3_reviewing'           // R1+R2 review+patch in parallel
  | 'phase3_cross_review'        // R1+R2 evaluate each other's conflicts
  | 'phase3_micro_gate'          // HUMAN GATE 3 — R1+R2 disagree
  | 'phase3_patching'            // DeepSeek applies resolved patches
  | 'phase3_re_review'           // R1+R2 verify patched file
  | 'phase3_arbitration'         // HUMAN GATE 4 — round 3 exhausted
  | 'phase3_budget_gate'         // HUMAN GATE (CRITICAL mode) — authorize spend before each file
  | 'output_gate'                // HUMAN GATE 5 — per-file approval
  | 'complete'
  | 'paused'
  | 'stopped'
  | 'error'

export interface PipelineConfig {
  coderProvider:  'deepseek'
  coderModelId:   'deepseek-v4-pro'
  coderApiKey:    string

  r1Provider:     Provider
  r1ModelId:      string
  r1ApiKey:       string

  r2Provider:     Provider
  r2ModelId:      string
  r2ApiKey:       string
}

export interface PipelineSessionState {
  sessionId:    string
  projectId:    string
  userId:       string
  phase:        PipelinePhase
  previousPhase?: PipelinePhase
  config:       PipelineConfig
  workspaceDir?: string | null
  mode?:         'new' | 'continue'
  projectName?:  string

  // Per-file loop tracking
  currentFileIdx:    number
  currentFilename:   string | null
  totalFiles:        number
  round:             number    // per-file round (1-3)

  // Phase 0
  taskDescription:   string
  contextText?:      string

  // Phase 1
  thinkingOutputs?: {
    r1: ThinkingOutput
    r2: ThinkingOutput
  }

  // Phase 1.5
  alignmentMessages?: AlignmentMessage[]

  // Phase 2
  questions?:        Question[]
  answers?:          Record<string, string>
  contradictions?:   Contradiction[]
  spec?:             SpecDocument
  fileManifest?:     FileManifest

  // Phase 3 — per-file state
  currentFileCode?:      string             // DeepSeek generated code for current file
  r1Hunks?:              ReviewHunk[]       // R1's review hunks for current file
  r2Hunks?:              ReviewHunk[]       // R2's review hunks for current file
  conflicts?:            HunkConflict[]     // overlapping hunks
  resolvedHunks?:        ResolvedHunk[]     // after cross-review + merge
  patchedCode?:          string             // after deterministic patch apply
  arbitrationPkg?:       ArbitrationPackage
  previousHunkRecords?:  PreviousHunkRecord[]  // passed to re-review for FIXED/NOT_FIXED verdicts
  compilerErrors?:       string[]             // compiler diagnostics from last verify pass
  regenAttempted?:       boolean              // one regen attempt at round 3 before arbitration
  regenHint?:            string               // hint built before resetPerFileState, used in regen generate
  budgetGateCleared?:    boolean              // CRITICAL: true after human approves this file's spend

  // Accepted files (all files)
  acceptedFiles:     Record<string, string>   // filename → final code
  streamingCode:     string

  // Output
  output?: ConsensusOutput    // kept for filesystem compatibility

  // Meta
  conversationHistory:    Message[]
  pendingHumanOverrides:  string[]
  budgetMode:             BudgetMode
  createdAt:              number
  updatedAt:              number
  error?:                 string
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
  | 'reviewer_edit'
  | 'coder_verify'
  | 'dialogue_message'
  | 'output_promoted'
  | 'checkpoint'
  | 'human_override'
  | 'conflict_escalated'
  | 'budget_mode_change'
  | 'pause'
  | 'play'
  | 'stop'

export type ConversationActor = Provider | 'human' | 'system' | 'coder'
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

// ─── Workspace Memory ─────────────────────────────────────────────────────────

export interface CrucibleDecision {
  timestamp:    string       // ISO8601
  questionId?:  string
  questionText: string
  answer:       string
  source:       'human' | 'auto' | 'arbitration'
}

export interface RegistryEntry {
  filename:   string
  sha256:     string
  acceptedAt: string       // ISO8601
  sessionId:  string
  exports:    string[]
  summary:    string
}

export type HistoryEvent =
  | { type: 'session_started';   timestamp: string; sessionId: string; taskDescription: string }
  | { type: 'question_answered'; timestamp: string; sessionId: string; questionId: string; questionText: string; answer: string; source: 'auto' | 'human' }
  | { type: 'spec_confirmed';    timestamp: string; sessionId: string }
  | { type: 'file_accepted';     timestamp: string; sessionId: string; filename: string; rounds: number; hunksApplied: number }
  | { type: 'arbitration';       timestamp: string; sessionId: string; filename: string; choice: string }
  | { type: 'session_completed'; timestamp: string; sessionId: string; costUsd: number; files: string[] }

export interface ProjectContext {
  specSummary:    string
  decisions:      CrucibleDecision[]
  fileIndex:      RegistryEntry[]
  driftedFiles:   string[]
  untrackedFiles: string[]
  crucibleMd:     string | null
  mode:           'new' | 'continue'
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
  | { type: 'phase_change';          phase: PipelinePhase }
  | { type: 'error';                 message: string; phase: PipelinePhase }
  | { type: 'done' }
  | { type: 'budget_update';         budget: BudgetStatus }
  | { type: 'heartbeat' }
  | { type: 'thinking_done';         actor: 'r1' | 'r2'; output: ThinkingOutput }
  | { type: 'alignment_msg';         message: AlignmentMessage }
  | { type: 'questions_ready';       questions: Question[] }
  | { type: 'contradiction';         contradiction: Contradiction }
  | { type: 'spec_ready';            spec: SpecDocument }
  | { type: 'manifest_ready';        manifest: FileManifest }
  | { type: 'file_generating';       filename: string; fileIndex: number; totalFiles: number }
  | { type: 'token';                 text: string }
  | { type: 'file_generated';        filename: string; code: string }
  | { type: 'review_hunks';          actor: 'r1' | 'r2'; hunks: ReviewHunk[] }
  | { type: 'hunks_merged';          resolved: ResolvedHunk[]; conflicts: HunkConflict[] }
  | { type: 'cross_review_response'; actor: 'r1' | 'r2'; response: CrossReviewResponse }
  | { type: 'conflicts_resolved';    resolved: ResolvedHunk[] }
  | { type: 'micro_gate';            conflict: HunkConflict }
  | { type: 'file_patched';          filename: string; code: string }
  | { type: 're_review_hunks';       actor: 'r1' | 'r2'; hunks: ReviewHunk[] }
  | { type: 'file_accepted';         filename: string; code: string }
  | { type: 'arbitration';           pkg: ArbitrationPackage }
  | { type: 'output_gate_ready';     files: Record<string, string> }
  | { type: 'consensus';             output: ConsensusOutput }
  | { type: 'verify_result';         filename: string; ok: boolean; errors: string[] }
  | { type: 'hunks_dropped';         filename: string; count: number; reasons: string[] }
  | { type: 'provider_retry';        provider: Provider; attempt: number; delayMs: number }
  | { type: 'usage_update';          provider: Provider; modelId: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }
  | { type: 'budget_degradation';   reason: string; skipped: string[] }
  | { type: 'budget_gate';          filename: string; fileIndex: number; totalFiles: number; spentUsd: number; remainingUsd: number; estimatedFileUsd: number }
