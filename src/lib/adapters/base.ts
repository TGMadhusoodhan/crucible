import { generateId } from '@/lib/utils'
import { estimateTokens } from '@/lib/utils/tokens'
import type {
  AcceptanceCriterion,
  AlignmentMessage,
  CrossReviewResponse,
  EdgeCase,
  FileDefinition,
  FileManifest,
  HunkConflict,
  ModelAdapter,
  PipelinePhase,
  Provider,
  Question,
  ResolvedHunk,
  ReviewHunk,
  SpecDocument,
  ThinkingOutput,
} from '@/types'
import { crossReviewResponseSchema, fileManifestSchema, reviewHunksSchema, thinkingOutputSchema } from '@/types'

// ─── Pricing table (per million tokens) ──────────────────────────────────────

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'deepseek-v4-pro':   { input: 0.435, output: 0.87  },
  'deepseek-v4-flash': { input: 0.14,  output: 0.28  },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'claude-opus-4-7':   { input: 5.00,  output: 25.00 },
  'gpt-4o':            { input: 2.50,  output: 10.00 },
  'gpt-5-4':           { input: 2.50,  output: 15.00 },
  'gpt-5-5':           { input: 5.00,  output: 30.00 },
  'gemini-pro':        { input: 1.25,  output: 5.00  },
  'mistral-large':     { input: 2.00,  output: 6.00  },
  'qwen3-coder-next':  { input: 0.11,  output: 0.80  },
}

// ─── System prompts ───────────────────────────────────────────────────────────

export const THINKING_SYSTEM_PROMPT = `You are a senior staff engineer at a world-class engineering organization. Before any implementation begins, you review a task and surface the decisions that the implementer would silently make — decisions where two reasonable engineers would make different choices, where the choices produce structurally different code, and where the requester did not specify which direction to take.

You call these "implementation forks."

─── HOW TO FIND AN IMPLEMENTATION FORK ──────────────────────────────────────

Read the task. As you read, ask: "If I started coding right now, what choices would I make that aren't specified here?" List them. For each one, ask two questions:

  1. Would the code look materially different depending on the answer?
     (Different data model, different algorithm, different external dependency = YES)
     (Different variable name, different log message = NO — not a fork)

  2. Can I ask this exact question about a completely unrelated software project?
     If yes, delete it. It is a generic engineering concern, not a task-specific ambiguity.

Only questions that pass BOTH tests become output questions.

─── WHAT A GOOD FORK LOOKS LIKE ────────────────────────────────────────────

Task: "Build a CSV parser"
  GOOD fork: "Should quoted fields support embedded newlines (RFC 4180 §2.6)?
              The parsing state machine looks completely different for each choice."
  BAD fork:  "How should parsing errors be handled?"
             (Every parser handles errors — this says nothing about THIS parser)

Task: "Build a rate limiter for our API"
  GOOD fork: "Sliding window or token bucket?
              Sliding window counts requests in a rolling time window — fairer but
              memory-heavier. Token bucket refills at a fixed rate — simpler but
              allows bursts at bucket boundaries."
  BAD fork:  "What are the performance requirements?"
             (Generic infrastructure question — not specific to rate limiting design)

Task: "Add session management to the auth service"
  GOOD fork: "Should session tokens be stored server-side (stateful) or be
              self-contained JWTs (stateless)? Stateful: O(1) revocation, requires
              shared store. Stateless: no revocation without a blocklist, no store needed."
  BAD fork:  "Does this need authentication?"
             (The task IS about authentication — this is not a fork)

─── OUTPUT FORMAT ───────────────────────────────────────────────────────────

Return ONLY this JSON — no prose, no markdown fences, nothing outside the JSON:

{
  "understood_as": "one precise sentence — what you are building, what it must do, for whom",
  "assumptions": [
    {
      "id": "a1",
      "description": "a decision you will make without asking because the answer is clear from the task or obvious from context",
      "confidence": "high|medium|low"
    }
  ],
  "questions": [
    {
      "id": "q1",
      "text": "the question — must name specific terms, behaviors, or constraints from this task",
      "why_this_is_a_fork": "one sentence: why two reasonable engineers would implement this differently without guidance, and why it matters structurally",
      "category": "core_behavior|security|error_handling|edge_cases|integration",
      "source": "primary",
      "options": [
        {
          "id": "o1",
          "label": "Concrete implementation name — not 'Option A', not 'Yes', not 'No'",
          "description": "what the code looks like with this choice, what tradeoffs it carries, when it is the right pick"
        }
      ],
      "recommended_option_id": "o1",
      "recommendation_reason": "why this option fits this task specifically — name the constraint or goal from the task that drives this recommendation",
      "is_required": true
    }
  ],
  "recommended_approach": "concrete implementation plan — name the specific functions, data structures, algorithms, or design patterns you will use",
  "risks": ["a specific technical risk that is particular to this task and approach — not a generic risk"]
}

─── HARD RULES ──────────────────────────────────────────────────────────────

Maximum 3 questions. Zero questions is a valid and often correct answer.
If the task is unambiguous enough to implement directly, return an empty array.

Every option label must be a named technical choice — no "Yes/No", no "Option A/B",
no "Standard approach", no "Default behavior".

why_this_is_a_fork must explain why the code differs between options — if you cannot
explain this concretely, the question is not a fork and must be removed.

QUESTIONS YOU MUST NEVER ASK (they are generic, not task-specific):
× Any form of "how should errors be handled"
× Any form of "does this need logging / monitoring / testing"
× Any form of "what are the performance or scale requirements"
× Authentication questions unless authentication is the core feature being built
× Data persistence questions unless the task explicitly leaves storage unspecified
× Any question whose answer is "obviously yes" or "obviously no" given the task

Output raw JSON only.`

export const ALIGNMENT_SYSTEM_PROMPT = `You are an expert model inside a multi-model coding pipeline.
You are in the ALIGNMENT phase. Another model has already shared its thinking about the same task.
Your job: compare positions, identify any architectural mismatches, and respond with your alignment message.

Return ONLY this exact JSON — no prose outside the JSON:
{
  "understood_as": "your interpretation of the task in one sentence",
  "questions_summary": ["key question you need answered", "another key question"],
  "position": "your position on architecture/approach — agree, refine, or flag conflict. Be specific."
}

Rules:
- If you agree with the other model's approach, say so explicitly and explain why
- If you see a conflict, describe it precisely — "Model A assumes stateless, I assume stateful because..."
- Keep position under 200 words
- Output raw JSON only. No markdown fences.`

export const PROPOSE_SPEC_MANIFEST_SYSTEM_PROMPT = `You are a senior
engineer reviewing a software task. Produce two things:
1. A complete specification
2. A file structure plan

RULES:
- Output ONLY valid JSON — no preamble, no markdown fences
- Spec: be precise and complete
- Manifest: define every file needed. No implementations — names, exports,
  and imports only. generation_order must list files dependency-first.

JSON schema:
{
  "spec": {
    "task_description": "string",
    "tech_stack": ["string"],
    "requirements": ["string"],
    "constraints": ["string"],
    "edge_cases": ["string"],
    "out_of_scope": ["string"],
    "acceptance_criteria": ["string"]
  },
  "manifest": {
    "mode": "single" | "multi",
    "files": [{
      "filename": "relative/path.ts",
      "purpose": "one sentence",
      "exports": ["Symbol"],
      "imports": { "other/file.ts": ["Symbol"] }
    }],
    "generation_order": ["dependency.ts", "entry.ts"],
    "reasoning": "one paragraph"
  }
}`

export const GENERATION_SYSTEM_PROMPT = `You are an expert software
engineer — the code generator in a multi-model pipeline.

RULES:
- Generate ONLY the single file requested
- Raw source code only — no markdown fences, no preamble, no explanations
- Exports must exactly match the manifest contract
- Use correct relative import paths from the manifest
- Production quality: error handling, edge cases, type safety`

export const REVIEW_AND_PATCH_SYSTEM_PROMPT = `You are a code reviewer.
For every issue you find, you MUST provide a complete fix.
Never output a flag without its replacement code.

OUTPUT: JSON array of ReviewHunk objects. Empty array [] if code is clean.
No preamble. No markdown fences.

[{
  "id": "unique_id",
  "filename": "src/file.ts",
  "line_start": 10,
  "line_end": 20,
  "severity": "HIGH" | "MEDIUM" | "LOW",
  "issue": "what is wrong — one sentence",
  "fixed_code": "complete replacement code for those exact lines",
  "category": "logic|security|performance|correctness|missing_implementation|edge_case|contract_violation"
}]

SEVERITY:
- HIGH:   Incorrect behavior, security hole, missing required implementation
- MEDIUM: Suboptimal but working, missing error handling
- LOW:    Style, naming, minor improvement

fixed_code rules:
- Must be a drop-in replacement for EXACTLY lines line_start to line_end
- No surrounding context lines — only the replacement
- Maintain the same indentation level as the original
- Must not break imports or exports defined in the manifest`

export const CROSS_REVIEW_SYSTEM_PROMPT = `You are evaluating a
competing fix from another reviewer for the same code location.
Be honest. If their fix is better, accept it.

Output ONLY valid JSON — no preamble, no fences.

{
  "conflict_id": "the conflict id provided",
  "decision": "ACCEPT_THEIRS" | "KEEP_MINE" | "NEW_FIX",
  "new_code": "...",
  "reason": "one sentence explanation"
}

ACCEPT_THEIRS: their fix correctly solves the issue and is as good or better
KEEP_MINE: your fix is more correct or handles more cases
NEW_FIX: both fixes are insufficient — provide a better implementation in new_code`

export const APPLY_PATCH_SYSTEM_PROMPT = `You are applying pre-decided code patches to a file.
The patches have already been reviewed and approved by both reviewers — your job is purely mechanical.

RULES:
- Apply each patch at exactly the specified line range — do not judge, improve, or second-guess them
- Do NOT touch any line outside the specified patch ranges
- Output ONLY the complete updated file — raw source code, no markdown fences, no explanation`

export const FIX_FILE_SYSTEM_PROMPT = `You are applying a human-requested
fix to a file that has already passed dual-model review and been finalized.

RULES:
- Make ONLY the change the instruction asks for — do not refactor, rename,
  reformat, or "improve" anything else in the file
- Output ONLY the complete updated file — raw source code, no markdown
  fences, no explanation`

// ─── JSON parsers ─────────────────────────────────────────────────────────────

/**
 * Fix two classes of malformed JSON produced by models embedding code in strings:
 *
 * 1. Literal control characters (newline, tab, CR, etc.) inside string values —
 *    JSON.parse rejects them per RFC 7159; replace with \\n, \\t, \\r, \\uXXXX.
 *
 * 2. Invalid backslash escape sequences inside string values — Python code often
 *    contains \d, \s, \w (regex), \n inside raw strings, \' single-quote escapes,
 *    etc. These are not valid JSON escapes so JSON.parse throws SyntaxError.
 *    We double the backslash: \d → \\d, keeping valid sequences (\\, \", \/, \b,
 *    \f, \n, \r, \t, \uXXXX) untouched.
 */
function sanitizeJsonString(text: string): string {
  const VALID_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'])

  let result  = ''
  let inString = false
  let i = 0

  while (i < text.length) {
    const ch   = text[i]!
    const code = ch.charCodeAt(0)

    if (!inString) {
      result += ch
      if (ch === '"') inString = true
      i++
      continue
    }

    // Inside a string value
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === undefined) {
        // Trailing backslash at end of input — escape it
        result += '\\\\'
        i++
        continue
      }

      if (VALID_ESCAPES.has(next)) {
        // Valid JSON escape — keep as-is (\n, \\, \", \uXXXX, etc.)
        if (next === 'u') {
          // \uXXXX — keep the full 6-char sequence
          result += text.slice(i, i + 6)
          i += 6
        } else {
          result += '\\' + next
          i += 2
        }
        continue
      }

      // Invalid escape (e.g. \d, \s, \w, \', \`) — double the backslash
      result += '\\\\' + next
      i += 2
      continue
    }

    if (ch === '"') {
      inString = false
      result += ch
      i++
      continue
    }

    if (code < 0x20) {
      // Literal control character — JSON-escape it
      if      (ch === '\n') result += '\\n'
      else if (ch === '\r') result += '\\r'
      else if (ch === '\t') result += '\\t'
      else result += `\\u${code.toString(16).padStart(4, '0')}`
      i++
      continue
    }

    result += ch
    i++
  }

  return result
}

/**
 * Scan `text` for valid JSON values (objects OR arrays) using a stack-based
 * bracket matcher. Returns them in order of appearance. This handles
 * prose-wrapped JSON like "Here's my analysis: {...}" where a greedy regex
 * would incorrectly capture from the first bracket in the prose to the last
 * bracket in the JSON.
 */
function extractJsonValues(text: string): string[] {
  const results: string[] = []
  let i = 0
  while (i < text.length) {
    const opener = text[i]
    if (opener !== '{' && opener !== '[') { i++; continue }
    const closer = opener === '{' ? '}' : ']'
    let depth = 0, inString = false, escape = false, j = i
    while (j < text.length) {
      const ch = text[j]
      if (escape)             { escape = false; j++; continue }
      if (ch === '\\' && inString) { escape = true;  j++; continue }
      if (ch === '"')         { inString = !inString; j++; continue }
      if (!inString) {
        if      (ch === opener) depth++
        else if (ch === closer) { depth--; if (depth === 0) { results.push(text.slice(i, j + 1)); break } }
      }
      j++
    }
    i = j + 1
  }
  return results
}

export function parseJSON<T>(text: string, phase: string): T | null {
  // Strip DeepSeek-Reasoner <think>...</think> blocks before any other processing
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  const candidates: string[] = []

  // 1. Each individual fence block as its own candidate. Some models (e.g. GLM-5.2)
  // split a response across two separate ```json blocks instead of one. Trying each
  // block individually handles the common single-block case, and the merge step below
  // handles the split case. The old greedy single-match (first...last ```) was wrong
  // when multiple blocks were present — it captured everything in between as one blob.
  const fenceBlocks = [...cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
    .map(m => m[1]?.trim() ?? '')
    .filter(Boolean)
  for (const block of fenceBlocks) candidates.push(block)

  // 1b. Merge all fence blocks into one object — handles models that output
  // { "spec": {...} } and { "manifest": {...} } as two separate code blocks.
  if (fenceBlocks.length > 1) {
    const merged: Record<string, unknown> = {}
    let anyParsed = false
    for (const block of fenceBlocks) {
      try {
        const parsed = JSON.parse(block) as Record<string, unknown>
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.assign(merged, parsed)
          anyParsed = true
        }
      } catch { /* skip unparseable blocks */ }
    }
    if (anyParsed) candidates.push(JSON.stringify(merged))
  }

  // 2. All syntactically valid JSON objects/arrays found via stack-based extraction
  for (const v of extractJsonValues(cleaned)) candidates.push(v)

  // 3. Full cleaned text as last-ditch attempt
  candidates.push(cleaned)

  for (const c of candidates) {
    const t = c.trim()
    if (!t.startsWith('{') && !t.startsWith('[')) continue
    // First attempt: raw parse
    try { return JSON.parse(t) as T } catch { /* fall through to sanitized attempt */ }
    // Second attempt: sanitize invalid escape sequences and literal control chars —
    // models embed Python/shell code with backslashes and newlines inside JSON strings.
    try { return JSON.parse(sanitizeJsonString(t)) as T } catch { /* try next candidate */ }
  }

  console.warn(`[${phase}] JSON parse failed (${text.length} chars). First 120:`, text.slice(0, 120))
  return null
}

export function parseThinkingOutput(text: string, provider: Provider, modelId: string, tokensUsed: number): ThinkingOutput {
  const raw = parseJSON<Record<string, unknown>>(text, 'think')
  if (!raw) {
    return {
      understood_as: 'Model returned unparseable output',
      assumptions: [],
      questions: [],
      recommended_approach: text.slice(0, 500),
      risks: ['Model did not return valid structured JSON — check model ID and API key'],
      provider,
      model_id: modelId,
      tokens_used: tokensUsed,
    }
  }
  // .catch() on every field means safeParse always succeeds — coerces bad/missing fields
  // to safe defaults instead of surfacing a schema error to the user.
  const result = thinkingOutputSchema.safeParse(raw)
  if (!result.success) {
    // Should not happen with .catch() on all fields, but keep as last resort
    return {
      understood_as: String(raw.understood_as ?? 'unknown'),
      assumptions: [],
      questions: [],
      recommended_approach: String(raw.recommended_approach ?? ''),
      risks: [],
      provider,
      model_id: modelId,
      tokens_used: tokensUsed,
    }
  }
  return { ...result.data, provider, model_id: modelId, tokens_used: tokensUsed }
}

export function parseReviewHunks(text: string, round: number): ReviewHunk[] {
  const raw = parseJSON<unknown[]>(text, 'reviewAndPatch')
  if (!Array.isArray(raw)) return []
  return reviewHunksSchema.parse(raw).map((h, i) => ({
    ...h,
    id: h.id || `h_${round}_${String(i + 1).padStart(3, '0')}`,
  }))
}

export function parseCrossReviewResponse(
  text: string, conflictId: string
): CrossReviewResponse {
  const raw = parseJSON<Record<string, unknown>>(text, 'crossReview')
  const result = crossReviewResponseSchema.safeParse(raw ?? {})
  return result.success
    ? { ...result.data, conflict_id: result.data.conflict_id || conflictId }
    : { conflict_id: conflictId, decision: 'KEEP_MINE', reason: 'parse failed' }
}

// The model is prompted for a flat spec shape (task_description, tech_stack,
// requirements, constraints, edge_cases: string[], out_of_scope,
// acceptance_criteria: string[]) that does NOT match the real SpecDocument
// type used across the rest of the app. This maps the model's flat output
// into the real shape rather than trusting an unchecked cast.
function buildSpecDocument(
  rawSpec:         Record<string, unknown>,
  taskDescription: string,
  answers:         Record<string, string>,
): SpecDocument {
  const toCriteria = (items: unknown): AcceptanceCriterion[] =>
    Array.isArray(items)
      ? items.map((description, i) => ({ id: `ac_${i + 1}`, description: String(description), test_case: '' }))
      : []

  const toEdgeCases = (items: unknown): EdgeCase[] =>
    Array.isArray(items)
      ? items.map((scenario, i) => ({ id: `ec_${i + 1}`, scenario: String(scenario), expected_behavior: '', test_case: '' }))
      : []

  // JSON-encoded rather than joined with a plain separator — a model-provided
  // string containing the separator itself (e.g. a requirement like "supports
  // both React; Vue") would otherwise silently split into two entries when
  // phase2-spec.ts's merge logic decodes this back into an array.
  const flatDefault = (items: unknown): string | null =>
    Array.isArray(items) && items.length > 0 ? JSON.stringify(items.map(String)) : null

  const model_defaults: Record<string, string> = {}
  for (const key of ['tech_stack', 'requirements', 'constraints', 'out_of_scope'] as const) {
    const joined = flatDefault(rawSpec[key])
    if (joined) model_defaults[key] = joined
  }

  return {
    id:                  generateId(),
    project_id:          '',
    session_id:          '',
    created_at:          new Date().toISOString(),
    task_description:    typeof rawSpec.task_description === 'string' ? rawSpec.task_description : taskDescription,
    user_decisions:      answers,
    model_defaults,
    acceptance_criteria: toCriteria(rawSpec.acceptance_criteria),
    edge_cases:          toEdgeCases(rawSpec.edge_cases),
    error_messages:      [],
    human_confirmed:     false,
  }
}

export function parseSpecAndManifest(
  text:            string,
  taskDescription: string,
  answers:         Record<string, string>,
): { spec: SpecDocument; manifest: FileManifest } | null {
  const raw = parseJSON<Record<string, unknown>>(text, 'proposeSpecAndManifest')
  if (!raw?.spec || !raw?.manifest) return null
  return {
    spec:     buildSpecDocument(raw.spec as Record<string, unknown>, taskDescription, answers),
    manifest: fileManifestSchema.parse(raw.manifest),
  }
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

export function buildThinkingPrompt(taskDescription: string, contextText?: string): string {
  const parts: string[] = []
  if (contextText) {
    parts.push('CODEBASE CONTEXT:', '```', contextText, '```', '')
  }
  parts.push('TASK:', taskDescription)
  return parts.join('\n')
}

// Prompt used when the first response was free-form (prose/code) — extracts structure from it
export function buildThinkingConversionPrompt(freeFormResponse: string, taskDescription: string): string {
  return `A software engineer was asked to analyze this task:
"${taskDescription.slice(0, 200)}"

Their analysis (may include code, prose, or a plan):
---
${freeFormResponse.slice(0, 4000)}
---

Extract the key information from the above and return ONLY this JSON (no fences, no prose):
{
  "understood_as": "one sentence — what is being built and for whom",
  "assumptions": [],
  "questions": [],
  "recommended_approach": "concrete plan — tech choices, data structures, key functions",
  "risks": ["any specific risks mentioned above"]
}`
}

// Helper used by adapters to detect the parse-failure fallback value.
// Also catches 'unknown' (Zod .catch default when model returned empty string)
// and very short strings that indicate the model gave a non-answer.
export function isUnparseableThinkingOutput(output: ThinkingOutput): boolean {
  return (
    output.understood_as === 'Model returned unparseable output' ||
    output.understood_as === 'unknown' ||
    output.understood_as.trim().length < 8
  )
}

export function buildAlignmentPrompt(
  round: 1 | 2,
  taskDescription: string,
  myThinking: ThinkingOutput,
  otherThinking: ThinkingOutput,
  previousMessages?: AlignmentMessage[],
  contextText?: string,
): string {
  const parts: string[] = []

  if (contextText) parts.push('CODEBASE CONTEXT:', contextText, '')

  parts.push('TASK:', taskDescription, '')

  parts.push(
    `ALIGNMENT ROUND ${round}/2`,
    '',
    'YOUR ANALYSIS:',
    `  Interpretation: ${myThinking.understood_as}`,
    `  Approach: ${myThinking.recommended_approach}`,
  )
  if (myThinking.questions.length > 0) {
    parts.push('  Implementation forks you identified:')
    myThinking.questions.forEach(q => parts.push(`    - ${q.text}`))
  }

  parts.push(
    '',
    "THE OTHER MODEL'S ANALYSIS:",
    `  Interpretation: ${otherThinking.understood_as}`,
    `  Approach: ${otherThinking.recommended_approach}`,
  )
  if (otherThinking.questions.length > 0) {
    parts.push('  Implementation forks they identified:')
    otherThinking.questions.forEach(q => parts.push(`    - ${q.text}`))
  }

  if (round === 2 && previousMessages && previousMessages.length > 0) {
    parts.push('', 'ROUND 1 EXCHANGE:')
    previousMessages.forEach(m =>
      parts.push(`  [${m.actor.toUpperCase()}] ${m.position}`)
    )
    parts.push(
      '',
      'Round 2: You have seen each other\'s round 1 positions above.',
      'If you now agree, confirm it explicitly and state the agreed approach.',
      'If a conflict remains, name it precisely in your position.',
    )
  }

  return parts.join('\n')
}

// ─── OpenAI-compatible message builder ───────────────────────────────────────

export type OpenAIMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export function buildOpenAIMessages(
  history: Array<{ role: string; content: string }>,
  prompt: string,
  systemPrompt: string,
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }]
  for (const msg of history) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({ role: msg.role, content: msg.content })
    }
  }
  messages.push({ role: 'user', content: prompt })
  return messages
}

// ─── Abstract base ────────────────────────────────────────────────────────────

export abstract class BaseAdapter implements ModelAdapter {
  abstract think(taskDescription: string, contextText?: string): Promise<ThinkingOutput>
  abstract chat(taskDescription: string, otherThinking: ThinkingOutput, myThinking: ThinkingOutput, round: 1 | 2): Promise<AlignmentMessage>
  abstract getProvider(): Provider
  abstract getModelId(): string

  // ─── Provider-specific primitives (implemented by concrete adapters) ───────
  // A single non-streaming completion — used for the JSON-returning calls below.
  protected abstract completeNonStreaming(systemPrompt: string, userMsg: string): Promise<string>
  // A streaming completion — used for raw code generation.
  protected abstract stream(systemPrompt: string, userMsg: string, onToken: (token: string) => void): Promise<void>

  estimateCost(inputTokens: number, outputTokens: number): number {
    const id = this.getModelId()
    const pricing = MODEL_PRICING[id]
      ?? MODEL_PRICING[id.toLowerCase()]
      ?? Object.entries(MODEL_PRICING).find(([k]) => k.toLowerCase() === id.toLowerCase())?.[1]
    if (!pricing) return 0
    return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output
  }

  protected makeAlignmentMessage(round: 1 | 2, actor: 'primary' | 'reviewer', raw: Record<string, unknown>): AlignmentMessage {
    return {
      id: generateId(),
      round,
      actor,
      understood_as:     String(raw.understood_as ?? ''),
      questions_summary: Array.isArray(raw.questions_summary) ? raw.questions_summary.map(String) : [],
      position:          String(raw.position ?? ''),
      timestamp:         Date.now(),
    }
  }

  // completeNonStreaming/stream only label errors generically ('completeNonStreaming',
  // 'stream') since they're shared by several call sites — re-wrap with the specific
  // phase here so failures stay identifiable to the user (which round/file/conflict).
  private wrapPhaseError(err: unknown, phase: string): Error {
    const message = err instanceof Error ? err.message : String(err)
    return new Error(`[${phase}] ${message}`)
  }

  // ─── Phase 2: R1/R2 jointly propose spec + file manifest ───────────────────

  async proposeSpecAndManifest(
    taskDescription: string,
    questions:       Question[],
    answers:         Record<string, string>,
    contextText?:    string,
  ): Promise<{ spec: SpecDocument; manifest: FileManifest }> {
    const contextBlock = contextText ? `\nCODEBASE CONTEXT:\n${contextText}\n` : ''
    const userMsg = [
      `TASK: ${taskDescription}`,
      `\nQUESTIONS AND ANSWERS:\n${JSON.stringify(
        questions.map(q => ({ q: q.text, a: answers[q.id] ?? 'not answered' })),
        null, 2
      )}`,
      contextBlock,
    ].join('\n')
    let raw: string
    try {
      raw = await this.completeNonStreaming(PROPOSE_SPEC_MANIFEST_SYSTEM_PROMPT, userMsg)
    } catch (err) {
      throw this.wrapPhaseError(err, 'proposeSpecAndManifest')
    }
    const result = parseSpecAndManifest(raw, taskDescription, answers)
    if (result) return result
    // Fallback — parse failed. id/project_id/session_id are session metadata the
    // orchestrator backfills after receiving this result.
    return {
      spec: {
        id:                  generateId(),
        project_id:          '',
        session_id:          '',
        created_at:          new Date().toISOString(),
        task_description:    taskDescription,
        user_decisions:      answers,
        model_defaults:      {},
        acceptance_criteria: [],
        edge_cases:          [],
        error_messages:      [],
        human_confirmed:     false,
      },
      manifest: {
        mode: 'single',
        files: [{ filename: 'output.ts', purpose: 'main output',
                  exports: [], imports: {} }],
        generation_order: ['output.ts'],
        reasoning: 'Fallback — parse failed',
      },
    }
  }

  // ─── Phase 3: DeepSeek generates the current file ──────────────────────────

  async generate(
    filename:       string,
    fileDef:        FileDefinition,
    manifest:       FileManifest,
    spec:           SpecDocument,
    generatedSoFar: Record<string, string>,
    contextText:    string | undefined,
    onToken:        (token: string) => void,
  ): Promise<{ code: string; tokensOut: number }> {
    const directDeps = Object.keys(fileDef.imports)
      .filter(dep => generatedSoFar[dep])
    const depContext = manifest.files
      .filter(f => f.filename !== filename && generatedSoFar[f.filename])
      .map(f => directDeps.includes(f.filename)
        ? `// === ${f.filename} (full code) ===\n${generatedSoFar[f.filename]}`
        : `// === ${f.filename} exports: ${f.exports.join(', ')} ===`)
      .join('\n\n')
    const userMsg = [
      `GENERATE: ${filename}`,
      `PURPOSE: ${fileDef.purpose}`,
      `MUST EXPORT: ${fileDef.exports.join(', ') || '(none)'}`,
      `IMPORTS NEEDED: ${Object.entries(fileDef.imports)
        .map(([f,s]) => `${s.join(',')} from '${f}'`).join('; ') || 'none'}`,
      '\nSPECIFICATION:',
      JSON.stringify(spec, null, 2),
      contextText ? `\nCODEBASE CONTEXT:\n${contextText}` : '',
      depContext   ? `\nGENERATED DEPENDENCIES:\n${depContext}` : '',
    ].filter(Boolean).join('\n')

    // Use streaming — follow the same pattern as the existing generate() method
    let code = ''
    try {
      await this.stream(GENERATION_SYSTEM_PROMPT, userMsg, (token) => {
        code += token
        onToken(token)
      })
    } catch (err) {
      throw this.wrapPhaseError(err, `generate:${filename}`)
    }
    // Strip accidental outer fence
    const clean = code.replace(/^```[^\n]*\n([\s\S]*?)```\s*$/m, '$1').trim()
    // onToken fires once per network chunk, not once per LLM token, so it can't be
    // used as a token count — estimate from the final code length instead.
    return { code: clean, tokensOut: estimateTokens(clean) }
  }

  // ─── Phase 3: R1/R2 review the file and produce drop-in fix hunks ──────────

  async reviewAndPatch(
    filename:       string,
    code:           string,
    spec:           SpecDocument,
    manifest:       FileManifest,
    round:          number,
    previousHunks?: ReviewHunk[],
  ): Promise<ReviewHunk[]> {
    const fileDef   = manifest.files.find(f => f.filename === filename)
    const prevBlock = previousHunks?.length
      ? `\nPREVIOUS UNRESOLVED ISSUES (focus on these):\n${JSON.stringify(previousHunks.map(h => ({ id: h.id, issue: h.issue })), null, 2)}`
      : ''
    const userMsg = [
      `FILE: ${filename}`,
      `PURPOSE: ${fileDef?.purpose ?? ''}`,
      `EXPECTED EXPORTS: ${fileDef?.exports.join(', ') ?? ''}`,
      '\nCODE:\n' + code,
      '\nSPECIFICATION:\n' + JSON.stringify(spec, null, 2),
      `\nRound ${round}/3.${prevBlock}`,
    ].join('\n')
    try {
      const raw = await this.completeNonStreaming(REVIEW_AND_PATCH_SYSTEM_PROMPT, userMsg)
      return parseReviewHunks(raw, round)
    } catch (err) {
      throw this.wrapPhaseError(err, `reviewAndPatch:${filename}:round${round}`)
    }
  }

  // ─── Phase 3: cross-review a conflicting hunk ───────────────────────────────

  async crossReview(
    conflict:  HunkConflict,
    myHunk:    ReviewHunk,
    theirHunk: ReviewHunk,
  ): Promise<CrossReviewResponse> {
    const userMsg = [
      `CONFLICT ID: ${conflict.id}`,
      `FILE: ${conflict.filename} lines ${conflict.line_start}-${conflict.line_end}`,
      '\nORIGINAL CODE:\n' + conflict.original_code,
      '\nYOUR FIX:\n' + myHunk.fixed_code,
      '\nYOUR REASONING: ' + myHunk.issue,
      '\nOTHER REVIEWER\'S FIX:\n' + theirHunk.fixed_code,
      '\nOTHER REVIEWER\'S REASONING: ' + theirHunk.issue,
    ].join('\n')
    try {
      const raw = await this.completeNonStreaming(CROSS_REVIEW_SYSTEM_PROMPT, userMsg)
      return parseCrossReviewResponse(raw, conflict.id)
    } catch (err) {
      throw this.wrapPhaseError(err, `crossReview:${conflict.id}`)
    }
  }

  // ─── Phase 3: coder mechanically applies reviewer-decided patches ──────────

  async applyPatch(
    filename:     string,
    originalCode: string,
    hunks:        ResolvedHunk[],
    onToken:      (token: string) => void,
  ): Promise<{ code: string; tokensOut: number }> {
    const sortedHunks = [...hunks].sort((a, b) => b.line_start - a.line_start)
    const userMsg = [
      'Apply these exact patches to the file.',
      'Do NOT modify any code outside the specified line ranges.',
      'Output the COMPLETE updated file.',
      '',
      `FILE (${filename}):`,
      originalCode,
      '',
      'PATCHES (apply exactly as specified):',
      ...sortedHunks.map(h =>
        `Lines ${h.line_start}-${h.line_end} → replace with:\n${h.new_code}`
      ),
    ].join('\n')

    let code = ''
    try {
      await this.stream(APPLY_PATCH_SYSTEM_PROMPT, userMsg, (token) => {
        code += token
        onToken(token)
      })
    } catch (err) {
      throw this.wrapPhaseError(err, `applyPatch:${filename}`)
    }
    const clean = code.replace(/^```[^\n]*\n([\s\S]*?)```\s*$/m, '$1').trim()
    return { code: clean, tokensOut: estimateTokens(clean) }
  }

  // ─── Output gate: ad-hoc human-requested fix ───────────────────────────────

  async fixFile(
    filename:    string,
    code:        string,
    instruction: string,
    onToken:     (token: string) => void,
  ): Promise<{ code: string; tokensOut: number }> {
    const userMsg = [
      `FILE (${filename}):`,
      code,
      '',
      `HUMAN INSTRUCTION: ${instruction}`,
    ].join('\n')

    let updated = ''
    try {
      await this.stream(FIX_FILE_SYSTEM_PROMPT, userMsg, (token) => {
        updated += token
        onToken(token)
      })
    } catch (err) {
      throw this.wrapPhaseError(err, `fixFile:${filename}`)
    }
    const clean = updated.replace(/^```[^\n]*\n([\s\S]*?)```\s*$/m, '$1').trim()
    return { code: clean, tokensOut: estimateTokens(clean) }
  }
}

// Re-export phase identifier for logging
export function phaseLabel(phase: PipelinePhase): string {
  const labels: Record<PipelinePhase, string> = {
    idle:                       'Idle',
    phase0_context:             'Phase 0: Context',
    phase1_thinking:            'Phase 1: Thinking',
    phase1_5_alignment:         'Phase 1.5: Alignment',
    phase2_questions:           'Phase 2: Questions',
    phase2_answering:           'Phase 2: Answering',
    phase2_contradiction_check: 'Phase 2: Contradiction Check',
    phase2_spec_and_manifest:   'Phase 2: Spec + Manifest',
    phase2_confirm:             'Phase 2: Confirm',
    phase3_generating:          'Phase 3: Generating',
    phase3_reviewing:           'Phase 3: Reviewing',
    phase3_cross_review:        'Phase 3: Cross-Review',
    phase3_micro_gate:          'Phase 3: Micro-Gate',
    phase3_patching:            'Phase 3: Patching',
    phase3_re_review:           'Phase 3: Re-Review',
    phase3_arbitration:         'Phase 3: Arbitration',
    output_gate:                'Output Gate',
    complete:                   'Complete',
    paused:                     'Paused',
    stopped:                    'Stopped',
    error:                      'Error',
  }
  return labels[phase] ?? phase
}
