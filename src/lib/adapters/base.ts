import { generateId } from '@/lib/utils'
import type {
  AlignmentMessage,
  CoderVerification,
  DialogueMessage,
  DialogueSummary,
  ModelAdapter,
  PipelineContext,
  PipelinePhase,
  Provider,
  ReviewEdit,
  ReviewHunk,
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

═══ OUTPUT FORMAT — MANDATORY ═══════════════════════════════════════════════════

SINGLE-FILE TASK: return the file content only. No preamble, no explanation, no markdown fences.

MULTI-FILE TASK: use ONLY these exact delimiters for every file:

=== FILE: relative/path/to/file.ext ===
(complete file content — every line)
=== /FILE ===

Rules that are NEVER negotiable:
× No prose before, between, or after the files
× No markdown fences of any kind — not around individual files, not around the whole output
× Do NOT wrap the entire output in a single \`\`\` block — that causes only one file to be parsed
× No "Here is the code", "Step 1:", "First I'll implement..."
× No "TODO", no placeholders, no "..." — every file must be complete
× Every file appears EXACTLY ONCE — never repeat or re-emit a file
× No explanation of what you wrote — the code explains itself

═══ IMPLEMENTATION RULES ═════════════════════════════════════════════════════════

NORMAL MODE (default):
- Write clean, correct, production-ready code
- Return the FULL implementation for every file
- Handle every edge case and error scenario in the spec
- Use the language and framework implied by the task
- Add a comment only when the WHY is genuinely non-obvious

PATCH MODE (activated when prompt begins with "PATCH MODE:"):
- A reviewer found specific bugs. Do NOT regenerate from scratch.
- Make ONLY the minimal targeted edits to fix the listed issues
- Touch nothing else — not variable names, not comments, not structure
- For multi-file output, preserve all === FILE: === delimiters and all other files byte-for-byte`

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

export const REVIEWER_EDIT_SYSTEM_PROMPT = `You are a code reviewer inside a multi-model coding pipeline.
You previously reviewed code and flagged specific bugs. Your job now: produce surgical code edits ONLY at the exact locations you flagged.

Use this EXACT format — one block per hunk, no JSON, no markdown:

=== HUNK ===
LOCATION: function name or line reference
REASON: one sentence — what bug this edit fixes
--- ORIGINAL ---
(the exact code snippet as it appears in the file — copied verbatim)
--- REPLACEMENT ---
(your corrected version of that exact snippet)
=== END HUNK ===

=== REASONING ===
One paragraph summarizing all the edits and which flag IDs they resolve.
=== END REASONING ===

CRITICAL RULES:
× NEVER touch code not directly related to the flagged issues
× ORIGINAL must be copied verbatim from the provided code — not paraphrased
× Only produce hunks for HIGH or MEDIUM severity issues — skip LOW issues
× If an issue requires architectural change (not a targeted edit), omit its hunk and explain in REASONING
× No prose outside the delimiters above`

export const CODER_VERIFY_SYSTEM_PROMPT = `You are the primary code generator in a multi-model pipeline.
A reviewer has made edits to your code. Your job: evaluate each edit honestly.

Return ONLY this exact JSON — no prose outside the JSON:
{
  "agrees": true,
  "accepted_hunks": ["location1", "location2"],
  "rejected_hunks": [],
  "concerns": [],
  "first_question": null
}

OR when you disagree:
{
  "agrees": false,
  "accepted_hunks": ["location1"],
  "rejected_hunks": ["location2"],
  "concerns": ["The replacement at location2 introduces a null dereference when input is empty"],
  "first_question": "Why did you replace the null check at location2 — doesn't that break the empty-input case?"
}

RULES:
- agrees: true ONLY when you accept ALL hunks and believe the merged code is correct
- For rejected_hunks: state exactly what is wrong with the reviewer's change in "concerns"
- first_question: a single direct question to start the dialogue (required when agrees=false)
- Be specific — "this change is wrong" is not useful; name the exact failure mode
- Output raw JSON only. No markdown fences.`

export const CODER_DIALOGUE_SYSTEM_PROMPT = `You are the primary code generator in a resolution dialogue with a reviewer.
The reviewer has responded to your previous concern. Read their response and either:
  a) Agree and end the dialogue — respond with a short message ending in "RESOLVED"
  b) Raise your next concern as a direct question

Keep your response under 100 words. Be direct and specific. No code — plain English only.`

export const REVIEWER_DIALOGUE_SYSTEM_PROMPT = `You are a code reviewer in a resolution dialogue with the primary code generator.
The coder has raised a concern about one of your edits. Respond to it directly.

Return ONLY this exact JSON:
{
  "response": "your response to the coder's concern — plain English, under 100 words",
  "resolved": false
}

Set resolved: true ONLY if the coder's last message signals they are satisfied (contains "RESOLVED").
Output raw JSON only. No markdown fences.`

// ─── JSON parsers ─────────────────────────────────────────────────────────────

/**
 * Escape literal control characters (newline, carriage return, tab, and all
 * other U+0000–U+001F) that appear inside JSON string values.
 *
 * Models frequently embed multi-line code in "original"/"replacement" hunk
 * fields using actual newline bytes rather than the \\n JSON escape sequence.
 * JSON.parse rejects literal control characters inside strings per RFC 7159,
 * so we fix them before parsing.
 */
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

  // 1. JSON inside a markdown fence — most reliable when model ignores "no fences" rule.
  // Use greedy match ([\s\S]*) so code hunks containing backticks don't truncate the capture.
  // Non-greedy would stop at the first ``` inside the JSON (e.g. python code in a hunk).
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*)```/)
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim())

  // 2. All syntactically valid JSON objects found via stack-based extraction
  for (const obj of extractJsonObjects(cleaned)) candidates.push(obj)

  // 3. Full cleaned text as last-ditch attempt
  candidates.push(cleaned)

  for (const c of candidates) {
    const t = c.trim()
    if (!t.startsWith('{')) continue
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

export function parseReviewEdit(text: string): ReviewEdit {
  // Primary path: delimiter-based format (=== HUNK === ... === END HUNK ===)
  // This avoids all JSON escaping issues with embedded code (quotes, backslashes, newlines).
  const hunkPattern = /=== HUNK ===\s*\nLOCATION:\s*(.+?)\nREASON:\s*(.+?)\n--- ORIGINAL ---\n([\s\S]*?)--- REPLACEMENT ---\n([\s\S]*?)=== END HUNK ===/g
  const hunks: ReviewHunk[] = []
  let match: RegExpExecArray | null

  while ((match = hunkPattern.exec(text)) !== null) {
    const [, location, reason, original, replacement] = match
    if (location && original !== undefined && replacement !== undefined) {
      hunks.push({
        location:    location.trim(),
        reason:      (reason ?? '').trim(),
        original:    original,      // preserve exact whitespace — applyHunks needs it
        replacement: replacement,
      })
    }
  }

  const reasoningMatch = text.match(/=== REASONING ===\s*\n([\s\S]*?)=== END REASONING ===/)
  const reasoning = reasoningMatch?.[1]?.trim() ?? ''

  if (hunks.length > 0 || reasoning) {
    return { hunks, reasoning, resolves: [] }
  }

  // Fallback: try JSON for models that ignore the format instruction
  const raw = parseJSON<Record<string, unknown>>(text, 'reviewerEdit')
  if (!raw) return { hunks: [], reasoning: 'Reviewer returned unparseable output — skipping edits', resolves: [] }

  const jsonHunks: ReviewHunk[] = []
  if (Array.isArray(raw.hunks)) {
    for (const h of raw.hunks as Array<Record<string, unknown>>) {
      if (typeof h.location === 'string' && typeof h.original === 'string' && typeof h.replacement === 'string') {
        jsonHunks.push({
          location:    h.location,
          original:    h.original,
          replacement: h.replacement,
          reason:      typeof h.reason === 'string' ? h.reason : '',
        })
      }
    }
  }
  return {
    hunks:     jsonHunks,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
    resolves:  Array.isArray(raw.resolves) ? raw.resolves.map(String) : [],
  }
}

export function parseCoderVerification(text: string): CoderVerification {
  const raw = parseJSON<Record<string, unknown>>(text, 'coderVerify')
  if (!raw) return {
    agrees:         false,
    accepted_hunks: [],
    rejected_hunks: [],
    concerns:       ['Coder returned malformed JSON — treating as disagreement'],
    first_question: 'Could you clarify your intent for all the changes?',
  }
  return {
    agrees:         Boolean(raw.agrees),
    accepted_hunks: Array.isArray(raw.accepted_hunks) ? raw.accepted_hunks.map(String) : [],
    rejected_hunks: Array.isArray(raw.rejected_hunks) ? raw.rejected_hunks.map(String) : [],
    concerns:       Array.isArray(raw.concerns) ? raw.concerns.map(String) : [],
    first_question: typeof raw.first_question === 'string' ? raw.first_question : undefined,
  }
}

export function parseReviewerDialogueResponse(text: string): { response: string; resolved: boolean } {
  const raw = parseJSON<Record<string, unknown>>(text, 'reviewerDialogue')
  if (!raw) return { response: text.slice(0, 500), resolved: false }
  return {
    response: typeof raw.response === 'string' ? raw.response : text.slice(0, 500),
    resolved: Boolean(raw.resolved),
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

  const formatReminder = [
    '',
    'OUTPUT FORMAT REMINDER:',
    '- Generate ALL files required by this task in a single response — do not stop early.',
    '- Multi-file task → use === FILE: path === ... === /FILE === for every file. Each file exactly once.',
    '- No prose, no markdown fences, no explanations. Code only.',
    '- Do not stop after the first file or first few files. Every file must be complete before you stop.',
  ]

  return [...specSummary, ...historySection, ...formatReminder].join('\n')
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

export function buildReviewerEditPrompt(
  code: string,
  spec: SpecDocument,
  review: ReviewPayload,
): string {
  const highMedFlags = review.flags.filter(f => f.severity !== 'LOW')
  const flagList = highMedFlags.map((f, i) => {
    const loc = f.location ? ` (${f.location})` : ''
    return `${i + 1}. [${f.severity}]${loc} ${f.description}`
  }).join('\n')

  return [
    'TASK:',
    spec.task_description,
    '',
    'YOUR REVIEW FLAGS (these are the issues to fix):',
    flagList || '(no HIGH/MEDIUM flags — return empty hunks)',
    '',
    'CODE TO EDIT:',
    '```',
    code,
    '```',
    '',
    'Produce surgical code hunks for ONLY the flagged issues above.',
    'Copy the ORIGINAL section verbatim from the code — it must match character-for-character.',
    'Use the === HUNK === ... === END HUNK === format from your instructions. No JSON, no markdown.',
  ].join('\n')
}

export function buildCoderVerifyPrompt(
  originalCode: string,
  edit: ReviewEdit,
  mergedCode: string,
  review: ReviewPayload,
): string {
  const hunkList = edit.hunks.map((h, i) =>
    `${i + 1}. [${h.location}]\n   Reason: ${h.reason}\n   Original:\n   ${h.original.slice(0, 200)}\n   Replacement:\n   ${h.replacement.slice(0, 200)}`
  ).join('\n\n')

  return [
    `REVIEWER'S EDITS (round ${review.round}):`,
    edit.reasoning,
    '',
    'INDIVIDUAL HUNKS:',
    hunkList || '(no hunks — reviewer found no fix)',
    '',
    'MERGED CODE (original + reviewer edits applied):',
    '```',
    mergedCode.slice(0, 8000),
    '```',
    '',
    'Evaluate each hunk. Do the reviewer\'s changes correctly fix the issues without introducing new bugs?',
    'Return raw JSON only.',
  ].join('\n')
}

export function buildCoderDialoguePrompt(
  code: string,
  dialogue: DialogueSummary,
  verification: CoderVerification,
): string {
  const history = dialogue.messages.map(m =>
    `[${m.actor.toUpperCase()} — Round ${m.round}]: ${m.content}`
  ).join('\n\n')

  return [
    'DIALOGUE HISTORY:',
    history || '(start of dialogue)',
    '',
    'YOUR CONCERNS SO FAR:',
    (verification.concerns.join('\n') || verification.first_question) ?? '',
    '',
    'Respond to the reviewer\'s last message. If satisfied, end with "RESOLVED".',
    'Plain English only — no code. Under 100 words.',
  ].join('\n')
}

export function buildReviewerDialoguePrompt(
  code: string,
  dialogue: DialogueSummary,
  review: ReviewPayload,
): string {
  const history = dialogue.messages.map(m =>
    `[${m.actor.toUpperCase()} — Round ${m.round}]: ${m.content}`
  ).join('\n\n')

  return [
    'ORIGINAL REVIEW REASONING:',
    review.reasoning,
    '',
    'DIALOGUE HISTORY:',
    history,
    '',
    'Respond to the coder\'s last concern. Plain English only — no code. Under 100 words.',
    'If the coder says "RESOLVED", set resolved: true in your JSON response.',
    'Return raw JSON only.',
  ].join('\n')
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
  abstract reviewerEdit(code: string, spec: SpecDocument, review: ReviewPayload, round: number): Promise<ReviewEdit>
  abstract coderVerify(originalCode: string, edit: ReviewEdit, mergedCode: string, review: ReviewPayload): Promise<CoderVerification>
  abstract coderDialogue(code: string, dialogue: DialogueSummary, verification: CoderVerification): Promise<string>
  abstract reviewerDialogue(code: string, dialogue: DialogueSummary, review: ReviewPayload): Promise<{ response: string; resolved: boolean }>
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
    phase3_reviewer_edit:   'Phase 3: Reviewer Editing',
    phase3_coder_verify:    'Phase 3: Coder Verifying',
    phase3_dialogue:        'Phase 3: Model Dialogue',
    phase3_consensus:       'Phase 3: Consensus',
    phase3_file_gate:       'Phase 3: File Review',
    phase3_file_feedback:   'Phase 3: File Feedback',
    conflict_escalated:     'Conflict Escalated',
    complete:               'Complete',
    paused:                 'Paused',
    stopped:                'Stopped',
    error:                  'Error',
  }
  return labels[phase] ?? phase
}
