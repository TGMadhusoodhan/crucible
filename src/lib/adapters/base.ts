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
  HunkVerdict,
  ModelAdapter,
  PipelinePhase,
  PreviousHunkRecord,
  Provider,
  Question,
  ResolvedHunk,
  ReviewHunk,
  SpecDocument,
  ThinkingOutput,
} from '@/types'
import { crossReviewResponseSchema, fileManifestSchema, reviewHunksSchema, thinkingOutputSchema } from '@/types'

// ─── Pricing table (per million tokens) ──────────────────────────────────────
// cacheRead:  price for tokens that were read from the prompt cache (cache hit)
// cacheWrite: price for tokens written to the prompt cache (cache creation, if separately billed)
// Providers that use implicit prefix caching (DeepSeek, OpenAI) charge cacheRead at a discount;
// cacheWrite == input price (no separate write charge).

export const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
  'deepseek-v4-pro':   { input: 0.435, output: 0.87,  cacheRead: 0.044, cacheWrite: 0.435 },
  'deepseek-v4-flash': { input: 0.14,  output: 0.28,  cacheRead: 0.014, cacheWrite: 0.14  },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  'claude-opus-4-7':   { input: 5.00,  output: 25.00, cacheRead: 0.50,  cacheWrite: 6.25  },
  'gpt-4o':            { input: 2.50,  output: 10.00, cacheRead: 1.25,  cacheWrite: 2.50  },
  'gpt-5-4':           { input: 2.50,  output: 15.00, cacheRead: 1.25,  cacheWrite: 2.50  },
  'gpt-5-5':           { input: 5.00,  output: 30.00, cacheRead: 2.50,  cacheWrite: 5.00  },
  'gemini-pro':        { input: 1.25,  output: 5.00  },
  'mistral-large':     { input: 2.00,  output: 6.00  },
  'qwen3-coder-next':  { input: 0.11,  output: 0.80  },
}

// ─── Streaming usage shape returned by stream() ───────────────────────────────

export interface StreamUsage {
  tokensIn:         number
  tokensOut:        number
  cacheReadTokens:  number
  cacheWriteTokens: number
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

export const REVIEW_AND_PATCH_SYSTEM_PROMPT = `You are a code reviewer in a multi-model quality gate.
For every issue you find, you MUST provide a complete fix with an exact anchor.

OUTPUT: JSON array only. Empty array [] if no issues.
No preamble. No markdown fences.

[{
  "id": "unique_id",
  "filename": "src/file.ts",
  "line_start": 10,
  "line_end": 20,
  "original_code": "EXACT verbatim text from the file that you are replacing — copy character-for-character including all whitespace and indentation. Minimum 3 lines, or must be unique in the file if shorter.",
  "fixed_code": "complete replacement for original_code — same indentation, correct syntax",
  "severity": "HIGH" | "MEDIUM" | "LOW",
  "issue": "what is wrong — one sentence",
  "category": "logic|security|performance|correctness|missing_implementation|edge_case|contract_violation"
}]

SEVERITY:
- HIGH:   Incorrect behavior, security hole, missing required implementation
- MEDIUM: Suboptimal but working, missing error handling
- LOW:    Style, naming, minor improvement

CRITICAL RULES FOR original_code:
- Copy it EXACTLY from the file, character-for-character
- Include ALL indentation and blank lines — do NOT trim
- It MUST appear verbatim in the file. If it does not match exactly, your fix is silently discarded
- Line numbers (line_start, line_end) are display hints only — do NOT include them in original_code or fixed_code
- fixed_code must be a complete replacement for original_code — same scope, correct indentation`

export const REVIEW_AND_PATCH_REVERIFY_SYSTEM_PROMPT = `You are re-verifying a file after patches were applied in a previous round.
Your job: confirm which issues were fixed, and flag any NEW high-severity issues.

OUTPUT: JSON object only. No preamble. No markdown fences.

{
  "verdicts": [
    { "id": "prev_hunk_id", "status": "FIXED" },
    {
      "id": "prev_hunk_id",
      "status": "NOT_FIXED",
      "hunk": {
        "id": "new_unique_id",
        "filename": "src/file.ts",
        "line_start": 10,
        "line_end": 20,
        "original_code": "EXACT verbatim text from the CURRENT file to replace",
        "fixed_code": "replacement code",
        "severity": "HIGH",
        "issue": "what remains wrong",
        "category": "logic|security|performance|correctness|missing_implementation|edge_case|contract_violation"
      }
    }
  ],
  "new_issues": [
    {
      "id": "unique_id",
      "filename": "src/file.ts",
      "line_start": 30,
      "line_end": 35,
      "original_code": "EXACT verbatim text from the CURRENT file",
      "fixed_code": "replacement code",
      "severity": "HIGH",
      "issue": "what is wrong",
      "category": "correctness"
    }
  ]
}

RULES:
- Output a verdict for EVERY previous issue ID provided
- Include "hunk" ONLY for NOT_FIXED verdicts
- Do NOT re-report MEDIUM/LOW issues from previous rounds
- Only flag genuinely new HIGH issues in new_issues
- original_code must appear verbatim in the CURRENT (patched) file
- Line numbers are display hints only — do NOT include them in original_code or fixed_code`

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

export function parseReviewHunks(
  text:  string,
  round: number,
  code?: string,  // the file content — used to validate original_code anchors
): { hunks: ReviewHunk[]; droppedCount: number; droppedReasons: string[] } {
  const raw = parseJSON<unknown[]>(text, 'reviewAndPatch')
  if (!Array.isArray(raw)) return { hunks: [], droppedCount: 0, droppedReasons: [] }

  const parsed = reviewHunksSchema.parse(raw).map((h, i) => ({
    ...h,
    id: h.id || `h_${round}_${String(i + 1).padStart(3, '0')}`,
  }))

  if (!code) return { hunks: parsed, droppedCount: 0, droppedReasons: [] }

  const valid:   ReviewHunk[] = []
  const dropped: string[]     = []

  for (const hunk of parsed) {
    const anchor = hunk.original_code?.trim()
    if (!anchor) {
      // No anchor provided — keep hunk but rely on line-hint fallback apply
      valid.push(hunk)
      continue
    }
    // Exact match
    if (code.includes(hunk.original_code!)) {
      valid.push(hunk)
      continue
    }
    // Whitespace-normalized match (handles trailing-space differences)
    const normalizedCode   = code.split('\n').map(l => l.trimEnd()).join('\n')
    const normalizedAnchor = hunk.original_code!.split('\n').map(l => l.trimEnd()).join('\n')
    if (normalizedCode.includes(normalizedAnchor)) {
      valid.push(hunk)
      continue
    }
    // No match — drop the hunk
    const reason = `hunk ${hunk.id} (${hunk.filename} ~L${hunk.line_start}): original_code not found in file`
    console.warn(`[reviewAndPatch] dropped hunk — ${reason}`)
    dropped.push(reason)
  }

  return { hunks: valid, droppedCount: dropped.length, droppedReasons: dropped }
}

// Parse a re-review response ({ verdicts, new_issues }) and return the subset
// of hunks that still need fixing (NOT_FIXED verdict hunks + new HIGH issues).
export function parseReReviewResponse(
  text:                string,
  previousHunkRecords: PreviousHunkRecord[],
  code:                string,
  round:               number,
): { hunks: ReviewHunk[]; droppedCount: number; droppedReasons: string[] } {
  const raw = parseJSON<Record<string, unknown>>(text, 'reReview')
  if (!raw) return { hunks: [], droppedCount: 0, droppedReasons: [] }

  const verdicts: HunkVerdict[] = Array.isArray(raw.verdicts)
    ? (raw.verdicts as unknown[]).map((v): HunkVerdict => {
        const obj = v as Record<string, unknown>
        return {
          id:   String(obj.id ?? ''),
          status: obj.status === 'FIXED' ? 'FIXED' : 'NOT_FIXED',
          hunk: obj.hunk ? (obj.hunk as ReviewHunk) : undefined,
        }
      })
    : []

  const newIssuesRaw: unknown[] = Array.isArray(raw.new_issues) ? raw.new_issues : []

  const resultHunks: ReviewHunk[] = []

  // Collect NOT_FIXED hunks (with updated fix from the verdict if provided)
  for (const verdict of verdicts) {
    if (verdict.status === 'NOT_FIXED') {
      if (verdict.hunk) {
        resultHunks.push({ ...verdict.hunk, id: verdict.hunk.id || `rev_${verdict.id}_${round}` })
      } else {
        // Model said NOT_FIXED but didn't provide a new hunk — find the original record
        const orig = previousHunkRecords.find(r => r.id === verdict.id)
        if (orig) {
          resultHunks.push({
            id:            `rev_${verdict.id}_${round}`,
            filename:      'unknown',
            line_start:    1,
            line_end:      1,
            severity:      'HIGH',
            issue:         orig.issue,
            original_code: orig.original_code,
            fixed_code:    '',
            category:      'correctness',
          })
        }
      }
    }
  }

  // Mark any previous issue not mentioned in verdicts as still outstanding
  for (const record of previousHunkRecords) {
    const mentioned = verdicts.some(v => v.id === record.id)
    if (!mentioned) {
      resultHunks.push({
        id:            `unverified_${record.id}_${round}`,
        filename:      'unknown',
        line_start:    1,
        line_end:      1,
        severity:      'HIGH',
        issue:         record.issue,
        original_code: record.original_code,
        fixed_code:    '',
        category:      'correctness',
      })
    }
  }

  // Collect new HIGH issues — validate directly without a JSON round-trip
  const droppedReasons: string[] = []
  let droppedCount = 0
  const rawNewHunks = reviewHunksSchema.parse(newIssuesRaw).map((h, i) => ({
    ...h,
    id: h.id || `new_${round}_${String(i + 1).padStart(3, '0')}`,
  }))
  for (const h of rawNewHunks) {
    if (h.severity !== 'HIGH') continue
    const anchor = h.original_code?.trim()
    if (anchor) {
      const inFile = code.includes(h.original_code!)
        || code.split('\n').map(l => l.trimEnd()).join('\n')
             .includes(h.original_code!.split('\n').map(l => l.trimEnd()).join('\n'))
      if (!inFile) {
        const reason = `new_issue ${h.id}: original_code not found in file`
        console.warn(`[reReview] dropped — ${reason}`)
        droppedReasons.push(reason)
        droppedCount++
        continue
      }
    }
    resultHunks.push(h)
  }

  return { hunks: resultHunks, droppedCount, droppedReasons }
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

// ─── Retry helper ─────────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [1_000, 4_000, 10_000] as const

function getRetryAfterMs(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'headers' in err) {
    const h = (err as { headers?: Record<string, string> }).headers
    const ra = h?.['retry-after'] ?? h?.['Retry-After']
    if (ra) { const ms = parseFloat(ra) * 1_000; if (!isNaN(ms)) return Math.ceil(ms) }
  }
  return undefined
}

function classifyError(err: unknown): 'retryable' | 'fail-fast' | 'no-retry' {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status: number }).status
    if (s === 400 || s === 401 || s === 403 || s === 404) return 'fail-fast'
    if (s === 429 || s === 500 || s === 502 || s === 503 || s === 529) return 'retryable'
    return 'no-retry'
  }
  if (err instanceof TypeError) return 'retryable'  // fetch() network failure
  const msg = err instanceof Error ? err.message : String(err)
  // Parse HTTP status embedded in Google/other error messages
  if (/\b(400|401|403|404)\b/.test(msg)) return 'fail-fast'
  if (/\b(429|500|502|503|529)\b/.test(msg)) return 'retryable'
  if (msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED') || msg.toLowerCase().includes('timeout')) {
    return 'retryable'
  }
  return 'no-retry'
}

export async function withRetry<T>(
  fn:       () => Promise<T>,
  onRetry?: (attempt: number, delayMs: number) => void,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === RETRY_DELAYS_MS.length) break
      if (classifyError(err) !== 'retryable') throw err  // fail fast on 4xx / unknown
      const retryAfter = getRetryAfterMs(err)
      // Jitter only for the base backoff — Retry-After is a server-mandated wait, don't add to it
      const delayMs = retryAfter != null
        ? retryAfter
        : RETRY_DELAYS_MS[attempt]! + Math.floor(Math.random() * 500)
      onRetry?.(attempt + 1, delayMs)
      await new Promise<void>(r => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

// ─── Abstract base ────────────────────────────────────────────────────────────

export abstract class BaseAdapter implements ModelAdapter {
  abstract think(taskDescription: string, contextText?: string): Promise<ThinkingOutput>
  abstract chat(taskDescription: string, otherThinking: ThinkingOutput, myThinking: ThinkingOutput, round: 1 | 2): Promise<AlignmentMessage>
  abstract getProvider(): Provider
  abstract getModelId(): string

  // Set by the orchestrator after adapter creation so retry events reach the SSE stream.
  retryEmitter?: (attempt: number, delayMs: number) => void
  setRetryEmitter(fn: (attempt: number, delayMs: number) => void): void {
    this.retryEmitter = fn
  }

  // ─── Provider-specific primitives (implemented by concrete adapters) ───────
  // A single non-streaming completion — used for the JSON-returning calls below.
  protected abstract completeNonStreaming(systemPrompt: string, userMsg: string): Promise<string>
  // A streaming completion — returns real token usage from the provider's API.
  // Retry for streaming calls is handled at the generate()/applyPatch()/fixFile()
  // level in BaseAdapter so the token accumulator can be reset on each attempt.
  protected abstract stream(systemPrompt: string, userMsg: string, onToken: (token: string) => void): Promise<StreamUsage>

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
    filename:          string,
    fileDef:           FileDefinition,
    manifest:          FileManifest,
    spec:              SpecDocument,
    generatedSoFar:    Record<string, string>,
    contextText:       string | undefined,
    onToken:           (token: string) => void,
    regenerationHint?: string,
  ): Promise<{ code: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; cacheWriteTokens: number }> {
    const directDeps = Object.keys(fileDef.imports)
      .filter(dep => generatedSoFar[dep])
    // depContext is built in manifest generation order and grows append-only as
    // more files complete. Appending new file content extends the cache prefix;
    // everything before the new entry remains a cache hit across calls.
    const depContext = manifest.files
      .filter(f => f.filename !== filename && generatedSoFar[f.filename])
      .map(f => directDeps.includes(f.filename)
        ? `// === ${f.filename} (full code) ===\n${generatedSoFar[f.filename]}`
        : `// === ${f.filename} exports: ${f.exports.join(', ')} ===`)
      .join('\n\n')

    // ── STABLE PREFIX — byte-identical across every file in the session ───────
    // Spec + codebase context come first so providers can cache-hit them on
    // every subsequent file. depContext grows monotonically in manifest order.
    // ── VARIABLE SUFFIX — changes per file ────────────────────────────────────
    const userMsg = [
      'SPECIFICATION:',
      JSON.stringify(spec, null, 2),
      contextText ? `\nCODEBASE CONTEXT:\n${contextText}` : '',
      depContext  ? `\nGENERATED DEPENDENCIES:\n${depContext}` : '',
      `\nGENERATE: ${filename}`,
      `PURPOSE: ${fileDef.purpose}`,
      `MUST EXPORT: ${fileDef.exports.join(', ') || '(none)'}`,
      `IMPORTS NEEDED: ${Object.entries(fileDef.imports)
        .map(([f,s]) => `${s.join(',')} from '${f}'`).join('; ') || 'none'}`,
      regenerationHint ? `\nREGENERATION GUIDANCE — avoid these specific defects:\n${regenerationHint}` : '',
    ].filter(Boolean).join('\n')

    // Streaming with retry — reset accumulator on each attempt so partial tokens
    // from a failed attempt are discarded. The UI receives a provider_retry event
    // (emitted via retryEmitter) to signal it should clear the streaming display.
    let code = ''
    let usage: StreamUsage = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    try {
      await withRetry(
        async () => {
          code = ''
          usage = await this.stream(GENERATION_SYSTEM_PROMPT, userMsg, (token) => {
            code += token
            onToken(token)
          })
        },
        this.retryEmitter,
      )
    } catch (err) {
      throw this.wrapPhaseError(err, `generate:${filename}`)
    }
    const clean = code.replace(/^```[^\n]*\n([\s\S]*?)```\s*$/m, '$1').trim()
    return {
      code:             clean,
      tokensIn:         usage.tokensIn,
      tokensOut:        usage.tokensOut || estimateTokens(clean),
      cacheReadTokens:  usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    }
  }

  // ─── Phase 3: R1/R2 review the file and produce anchor-based fix hunks ──────
  // Round 1 → full initial review (REVIEW_AND_PATCH_SYSTEM_PROMPT).
  // Round > 1 → re-review mode: returns FIXED/NOT_FIXED verdicts + new HIGH issues only.

  async reviewAndPatch(
    filename:              string,
    code:                  string,
    spec:                  SpecDocument,
    manifest:              FileManifest,
    round:                 number,
    previousHunkRecords?:  PreviousHunkRecord[],
    compilerErrors?:       string[],
  ): Promise<{ hunks: ReviewHunk[]; droppedCount: number }> {
    const fileDef = manifest.files.find(f => f.filename === filename)

    // Send code with line-number prefix so hints are grounded (display only)
    const numberedCode = code.split('\n')
      .map((line, i) => `${String(i + 1).padStart(4, ' ')}|  ${line}`)
      .join('\n')

    const compilerBlock = compilerErrors?.length
      ? `\nCOMPILER ERRORS (fix these first — ground truth, not opinions):\n${compilerErrors.join('\n')}`
      : ''

    try {
      if (round === 1 || !previousHunkRecords?.length) {
        // ── Initial review ──────────────────────────────────────────────────
        // Spec first → stable prefix cache hit after the first file.
        const userMsg = [
          'SPECIFICATION:\n' + JSON.stringify(spec, null, 2),
          `FILE: ${filename}`,
          `PURPOSE: ${fileDef?.purpose ?? ''}`,
          `EXPECTED EXPORTS: ${fileDef?.exports.join(', ') ?? ''}`,
          compilerBlock,
          '\nCODE (line numbers are display-only — do NOT include them in original_code/fixed_code):\n' + numberedCode,
        ].filter(Boolean).join('\n')
        const raw = await this.completeNonStreaming(REVIEW_AND_PATCH_SYSTEM_PROMPT, userMsg)
        const { hunks, droppedCount } = parseReviewHunks(raw, round, code)
        return { hunks, droppedCount }
      } else {
        // ── Re-review mode (round > 1) ──────────────────────────────────────
        const prevBlock = previousHunkRecords.map(r =>
          `  { "id": "${r.id}", "issue": "${r.issue}", "original_code": ${JSON.stringify(r.original_code)}, "fixed_code": ${JSON.stringify(r.fixed_code)} }`
        ).join(',\n')
        // Spec first → stable prefix cache hit across re-review rounds.
        const userMsg = [
          'SPECIFICATION:\n' + JSON.stringify(spec, null, 2),
          `FILE: ${filename} — RE-REVIEW ROUND ${round}`,
          `PURPOSE: ${fileDef?.purpose ?? ''}`,
          compilerBlock,
          '\nPREVIOUS ISSUES APPLIED (issue each a FIXED/NOT_FIXED verdict):',
          `[\n${prevBlock}\n]`,
          '\nCURRENT FILE (after patches — line numbers are display-only):\n' + numberedCode,
        ].filter(Boolean).join('\n')
        const raw = await this.completeNonStreaming(REVIEW_AND_PATCH_REVERIFY_SYSTEM_PROMPT, userMsg)
        const { hunks, droppedCount, droppedReasons } = parseReReviewResponse(raw, previousHunkRecords, code, round)
        return { hunks, droppedCount: droppedCount + droppedReasons.length }
      }
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
  ): Promise<{ code: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; cacheWriteTokens: number }> {
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
    let usage: StreamUsage = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    try {
      await withRetry(
        async () => {
          code = ''
          usage = await this.stream(APPLY_PATCH_SYSTEM_PROMPT, userMsg, (token) => {
            code += token
            onToken(token)
          })
        },
        this.retryEmitter,
      )
    } catch (err) {
      throw this.wrapPhaseError(err, `applyPatch:${filename}`)
    }
    const clean = code.replace(/^```[^\n]*\n([\s\S]*?)```\s*$/m, '$1').trim()
    return {
      code:             clean,
      tokensIn:         usage.tokensIn,
      tokensOut:        usage.tokensOut || estimateTokens(clean),
      cacheReadTokens:  usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    }
  }

  // ─── Output gate: ad-hoc human-requested fix ───────────────────────────────

  async fixFile(
    filename:    string,
    code:        string,
    instruction: string,
    onToken:     (token: string) => void,
  ): Promise<{ code: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; cacheWriteTokens: number }> {
    const userMsg = [
      `FILE (${filename}):`,
      code,
      '',
      `HUMAN INSTRUCTION: ${instruction}`,
    ].join('\n')

    let updated = ''
    let usage: StreamUsage = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    try {
      await withRetry(
        async () => {
          updated = ''
          usage = await this.stream(FIX_FILE_SYSTEM_PROMPT, userMsg, (token) => {
            updated += token
            onToken(token)
          })
        },
        this.retryEmitter,
      )
    } catch (err) {
      throw this.wrapPhaseError(err, `fixFile:${filename}`)
    }
    const clean = updated.replace(/^```[^\n]*\n([\s\S]*?)```\s*$/m, '$1').trim()
    return {
      code:             clean,
      tokensIn:         usage.tokensIn,
      tokensOut:        usage.tokensOut || estimateTokens(clean),
      cacheReadTokens:  usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    }
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
