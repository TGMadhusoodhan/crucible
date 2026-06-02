import { generateId } from '@/lib/utils'
import type {
  AlignmentMessage,
  ModelAdapter,
  PipelineContext,
  PipelinePhase,
  Provider,
  ReviewPayload,
  SpecDocument,
  ThinkingOutput,
} from '@/types'
import { reviewPayloadSchema, selfCheckOutputSchema, thinkingOutputSchema } from '@/types'

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

export const GENERATION_SYSTEM_PROMPT = `You are an expert software engineer — the primary code generator in a multi-model pipeline.
You have received a confirmed specification. Your job: implement it completely.

NORMAL MODE (default):
- Write clean, correct, production-ready code
- Return the FULL implementation — no placeholders, no TODO, no truncation
- Handle every edge case and error scenario listed in the spec
- Use the language and framework implied by the task
- Add a comment only when the reason is genuinely non-obvious
- Return code directly — no preamble like "Here is the code:"

PATCH MODE (activated when prompt begins with "PATCH MODE:"):
- A reviewer found specific bugs. Do NOT regenerate from scratch.
- Read the provided code carefully
- Make ONLY the minimal targeted edits to fix the listed issues — touch nothing else
- Return the complete patched file — every unflagged line must be identical to the original`

export const SELF_CHECK_SYSTEM_PROMPT = `You are a software engineer reviewing your own code.
Your job: find bugs in the code you just wrote, using the spec as the source of truth.

Return ONLY this exact JSON — no prose outside the JSON:
{
  "pass": 1,
  "issues": [
    {
      "severity": "high|medium|low",
      "description": "what is wrong",
      "location": "optional — function name or line reference",
      "suggested_fix": "plain English only — max 3 lines — NO code syntax"
    }
  ],
  "all_clear": false,
  "reasoning": "one paragraph summary"
}

Rules:
- suggested_fix must be PLAIN ENGLISH — never write actual code syntax
- GOOD: "check that the array is non-empty before accessing index 0"
- BAD:  "if (!arr.length) return []"   ← that is code, forbidden
- Set all_clear: true only if you found zero issues
- Output raw JSON only. No markdown fences.`

export const REVIEWER_SYSTEM_PROMPT = `You are a code reviewer inside a multi-model coding pipeline.
The primary model wrote the code. Your job: find bugs and return a structured JSON report.
You must NEVER write full code. Only plain-English pseudo-code hints of max 3 lines each.

Return ONLY this exact JSON — no prose outside the JSON:
{
  "consensus": false,
  "round": 1,
  "flags": [
    {
      "id": "f1",
      "severity": "HIGH|MEDIUM|LOW",
      "category": "bug|logic|security|performance|edge_case",
      "description": "what is wrong",
      "pseudo_code_hint": "plain English fix hint — max 3 lines — NO code syntax",
      "location": "optional — function name or line reference"
    }
  ],
  "critical_bugs": ["HIGH severity bug descriptions only"],
  "logic_errors": ["MEDIUM logic issue descriptions only"],
  "edge_cases_missed": ["edge case descriptions only"],
  "pseudo_code_hints": ["all hints in one flat list"],
  "reasoning": "one paragraph summary",
  "dependencies_rechecked": false
}

Flag routing rules:
- HIGH/MEDIUM severity → include pseudo_code_hint (sent back to primary for patching)
- LOW severity → include description only (goes to review_list, not primary)
- consensus: true ONLY when you find zero HIGH or MEDIUM issues
- In rounds 2+, set dependencies_rechecked: true after verifying no new issues introduced

PSEUDO-CODE HINT RULES:
- GOOD: "check that userId is non-null before the DB call"
- GOOD: "loop must handle empty array — check length before accessing index 0"
- BAD:  "if (!userId) return null"    ← code syntax, forbidden
- BAD:  "function fix() { ... }"      ← code syntax, forbidden

Output raw JSON only. No markdown fences. No explanation before or after.`

// ─── JSON parsers ─────────────────────────────────────────────────────────────

/**
 * Scan `text` for valid JSON objects using a stack-based brace matcher.
 * Returns them in order of appearance (outermost first per starting `{`).
 * This handles prose-wrapped JSON like "Here's my analysis: {...}" where the
 * greedy regex /\{[\s\S]*\}/ would incorrectly capture from the first "{" in
 * the prose to the last "}" in the JSON.
 */
function extractJsonObjects(text: string): string[] {
  const results: string[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== '{') { i++; continue }
    let depth = 0, inString = false, escape = false, j = i
    while (j < text.length) {
      const ch = text[j]
      if (escape)            { escape = false; j++; continue }
      if (ch === '\\' && inString) { escape = true;  j++; continue }
      if (ch === '"')        { inString = !inString; j++; continue }
      if (!inString) {
        if      (ch === '{') depth++
        else if (ch === '}') { depth--; if (depth === 0) { results.push(text.slice(i, j + 1)); break } }
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

  // 1. JSON inside a markdown fence — most reliable when model ignores "no fences" rule
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim())

  // 2. All syntactically valid JSON objects found via stack-based extraction
  for (const obj of extractJsonObjects(cleaned)) candidates.push(obj)

  // 3. Full cleaned text as last-ditch attempt
  candidates.push(cleaned)

  for (const c of candidates) {
    const t = c.trim()
    if (!t.startsWith('{')) continue
    try { return JSON.parse(t) as T } catch { /* try next candidate */ }
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

export function parseSelfCheckOutput(text: string, pass: 1 | 2) {
  const raw = parseJSON<Record<string, unknown>>(text, 'selfCheck')
  if (!raw) return {
    pass,
    issues: [{ severity: 'high' as const, description: 'Self-check returned unparseable output', suggested_fix: 'Retry the self-check' }],
    all_clear: false,
    reasoning: 'Model did not return valid JSON',
  }
  const result = selfCheckOutputSchema.safeParse({ ...raw, pass })
  if (!result.success) return {
    pass,
    issues: [],
    all_clear: false,
    reasoning: `Schema validation failed: ${result.error.issues[0]?.message}`,
  }
  return result.data
}

export function parseReviewPayload(text: string, round: number): ReviewPayload {
  const raw = parseJSON<Record<string, unknown>>(text, 'review')

  const looksLikeTruncation = text.length > 0 && !text.trimEnd().endsWith('}')

  if (!raw) {
    return {
      consensus: false,
      round,
      flags: [],
      critical_bugs: [looksLikeTruncation
        ? 'Reviewer output was truncated — try again'
        : 'Reviewer returned malformed JSON — check model ID and API key'],
      logic_errors: [],
      edge_cases_missed: [],
      pseudo_code_hints: [],
      reasoning: `${looksLikeTruncation ? 'Output truncated' : 'Parse failed'}: ${text.slice(0, 800)}`,
      dependencies_rechecked: false,
    }
  }

  const result = reviewPayloadSchema.safeParse({ ...raw, round })
  if (!result.success) {
    // Best-effort fallback from partial data
    return {
      consensus: Boolean(raw.consensus),
      round,
      flags: [],
      critical_bugs: (raw.critical_bugs as string[] | undefined) ?? [],
      logic_errors: (raw.logic_errors as string[] | undefined) ?? [],
      edge_cases_missed: (raw.edge_cases_missed as string[] | undefined) ?? [],
      pseudo_code_hints: (raw.pseudo_code_hints as string[] | undefined) ?? [],
      reasoning: String(raw.reasoning ?? ''),
      dependencies_rechecked: Boolean(raw.dependencies_rechecked),
    }
  }

  // Sanitize pseudo-code hints: strip any that contain code syntax
  const cleanHints = result.data.pseudo_code_hints.map((h) =>
    h.replace(/[{};]|function\s+\w+\s*\(|=>\s*{|\bif\s*\(|\bfor\s*\(|\bwhile\s*\(/g, '').trim()
  )
  return { ...result.data, pseudo_code_hints: cleanHints }
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
  previousMessages?: import('@/types').AlignmentMessage[],
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

export function buildGenerationPrompt(ctx: PipelineContext, patchInstructions?: { code: string; review: ReviewPayload }): string {
  if (patchInstructions) {
    // Issues listed BEFORE the code so the model forms targeted-edit intent
    // before it reads a single line of the original — prevents the "plan a rewrite"
    // failure mode that occurs when code appears first.
    const flagsWithHints = patchInstructions.review.flags
      .filter(f => f.severity !== 'LOW')
      .map((f, i) => {
        const loc  = f.location ? ` (${f.location})` : ''
        const hint = f.pseudo_code_hint ? `\n   How to fix: ${f.pseudo_code_hint}` : ''
        return `${i + 1}. [${f.severity}]${loc} ${f.description}${hint}`
      })
      .join('\n')

    const issueList = flagsWithHints ||
      patchInstructions.review.pseudo_code_hints
        .map((h, i) => `${i + 1}. ${h}`)
        .join('\n')

    return [
      'PATCH MODE — targeted fixes only.',
      '',
      'ISSUES TO FIX (make the minimum possible edit to each):',
      issueList,
      '',
      'STRICT RULES:',
      '× Do NOT rename variables, functions, or parameters',
      '× Do NOT reorder, reorganize, or restructure code',
      '× Do NOT add, remove, or reword comments',
      '× Do NOT change any line not directly fixing an issue above',
      '',
      'ORIGINAL CODE (edit in-place — only at the exact locations of the issues above):',
      '```',
      patchInstructions.code,
      '```',
      '',
      'Return the complete file. Every line not directly involved in a fix must be byte-for-byte identical.',
    ].join('\n')
  }

  const specSummary = [
    `TASK: ${ctx.taskDescription}`,
    '',
    'ACCEPTANCE CRITERIA:',
    ...ctx.spec.acceptance_criteria.map((c, i) => `${i + 1}. ${c.description}`),
    '',
    'EDGE CASES TO HANDLE:',
    ...ctx.spec.edge_cases.map((e, i) => `${i + 1}. ${e.scenario} → ${e.expected_behavior}`),
    '',
    'ERROR MESSAGES:',
    ...ctx.spec.error_messages.map((e, i) => `${i + 1}. ${e.trigger} → "${e.message}"`),
  ]

  if (ctx.contextText) {
    specSummary.unshift('CODEBASE CONTEXT:', '```', ctx.contextText, '```', '')
  }

  const historySection = ctx.history.length > 0
    ? [
        '',
        'CONVERSATION HISTORY (most recent first):',
        ...ctx.history.slice(-20).reverse().map(m => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 300)}`),
      ]
    : []

  return [...specSummary, ...historySection].join('\n')
}

export function buildSelfCheckPrompt(
  code: string,
  spec: SpecDocument,
  pass: 1 | 2,
  previousIssues?: import('@/types').SelfCheckIssue[],
): string {
  const parts: string[] = [`SELF-CHECK PASS ${pass}/2`, '']

  if (pass === 2 && previousIssues && previousIssues.length > 0) {
    parts.push(
      'PASS 1 ISSUES (already patched — verify each fix worked and check for regressions):',
      ...previousIssues.map((issue, i) =>
        `  ${i + 1}. [${issue.severity.toUpperCase()}]${issue.location ? ` (${issue.location})` : ''} ${issue.description}\n     Fix applied: ${issue.suggested_fix}`
      ),
      '',
      'Your tasks for pass 2:',
      '  1. Confirm each pass-1 issue is now resolved',
      '  2. Find any regression introduced by the pass-1 patch',
      '  3. Find any remaining spec violations not addressed in pass 1',
      '',
    )
  }

  parts.push(
    'CODE TO CHECK:',
    '```',
    code,
    '```',
    '',
    'SPEC REQUIREMENTS:',
    ...spec.acceptance_criteria.map((c, i) => `${i + 1}. ${c.description}`),
    '',
    'EDGE CASES THAT MUST BE HANDLED:',
    ...spec.edge_cases.map((e, i) => `${i + 1}. ${e.scenario} → ${e.expected_behavior}`),
    '',
    pass === 2
      ? 'Verify the pass-1 fixes, find regressions, and report any remaining issues. Your JSON response:'
      : 'Find every bug, missing case, or spec violation. Be thorough. Your JSON response:',
  )

  return parts.join('\n')
}

export function buildReviewPrompt(
  code: string,
  spec: SpecDocument,
  round: number,
  previousReview?: ReviewPayload,
): string {
  const parts: string[] = [
    `REVIEW ROUND ${round}`,
    '',
    'ORIGINAL TASK:',
    spec.task_description,
    '',
    'ACCEPTANCE CRITERIA:',
    ...spec.acceptance_criteria.map((c, i) => `${i + 1}. ${c.description}`),
    '',
  ]

  if (round > 1 && previousReview) {
    const prevHighMed = previousReview.flags.filter(f => f.severity !== 'LOW')
    if (prevHighMed.length > 0) {
      parts.push(
        'PREVIOUSLY FLAGGED ISSUES (check if resolved):',
        ...prevHighMed.map(f => `• [${f.severity}] ${f.description}`),
        '',
        'Set dependencies_rechecked: true in your response after verifying these.',
        '',
      )
    }
  }

  parts.push('CODE TO REVIEW:', '```', code, '```')

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
  abstract chat(round: 1 | 2, taskDescription: string, myThinking: ThinkingOutput, otherThinking: ThinkingOutput, previousMessages?: AlignmentMessage[], contextText?: string): Promise<AlignmentMessage>
  abstract generate(prompt: string, ctx: PipelineContext): AsyncGenerator<string>
  abstract selfCheck(code: string, spec: SpecDocument, pass: 1 | 2): ReturnType<ModelAdapter['selfCheck']>
  abstract review(code: string, spec: SpecDocument, round: number, previousReview?: ReviewPayload): Promise<ReviewPayload>
  abstract getProvider(): Provider
  abstract getModelId(): string

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
}

// Re-export phase identifier for logging
export function phaseLabel(phase: PipelinePhase): string {
  const labels: Record<PipelinePhase, string> = {
    idle:                   'Idle',
    phase0_context:         'Phase 0: Context',
    phase1_thinking:        'Phase 1: Thinking',
    phase1_5_alignment:     'Phase 1.5: Alignment',
    phase2_questions:       'Phase 2: Questions',
    phase2_answering:       'Phase 2: Answering',
    phase2_contradictions:  'Phase 2: Contradictions',
    phase2_spec:            'Phase 2: Spec',
    phase2_spec_confirm:    'Phase 2: Spec Confirm',
    phase3_generating:      'Phase 3: Generating',
    phase3_self_check:      'Phase 3: Self-Check',
    phase3_reviewing:       'Phase 3: Reviewing',
    phase3_consensus:       'Phase 3: Consensus',
    conflict_escalated:     'Conflict Escalated',
    complete:               'Complete',
    paused:                 'Paused',
    stopped:                'Stopped',
    error:                  'Error',
  }
  return labels[phase] ?? phase
}
