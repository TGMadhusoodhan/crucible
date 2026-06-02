import { logGenerationDone, logGenerationStart, logPhaseStart, logSelfCheck } from '@/lib/memory/session-log'
import { buildGenerationPrompt } from '@/lib/adapters/base'
import { retryWithTimeout, TIMEOUT_DEFAULT_MS } from '@/lib/utils/retry'
import { estimateTokens } from '@/lib/utils/tokens'
import type {
  ModelAdapter,
  PipelineContext,
  ReviewPayload,
  SelfCheckOutput,
  SSEEvent,
} from '@/types'

// Architecture rule: max 2 self-check passes — enforced here.
const MAX_SELF_CHECK_PASSES = 2

// Two-tier idle timeouts for streaming generation.
// First token: models can think silently for minutes before streaming starts.
// Inter-token: once streaming begins, long gaps indicate a real hang.
const FIRST_TOKEN_TIMEOUT_MS = 600_000  // 10 min — reasoning models think before first token
const INTER_TOKEN_TIMEOUT_MS =  90_000  // 90s — gaps between tokens should be short

// ─── Streaming code generation with idle timeout ──────────────────────────────

async function generateCode(
  primary: ModelAdapter,
  prompt:  string,
  ctx:     PipelineContext,
  emit:    (event: SSEEvent) => void,
): Promise<string> {
  const stream = primary.generate(prompt, ctx)
  let code = ''

  // Race each stream.next() against an idle timer.
  // First token gets a longer window — the model may be doing silent reasoning.
  // Once streaming starts, gaps should be short; 90s of silence = real hang.
  function nextWithIdleTimeout(isFirst: boolean): Promise<IteratorResult<string>> {
    const ms    = isFirst ? FIRST_TOKEN_TIMEOUT_MS : INTER_TOKEN_TIMEOUT_MS
    const label = isFirst
      ? `No response from model after ${ms / 1000}s. The model may be overloaded — try again.`
      : `Model stopped streaming mid-response for ${ms / 1000}s. Try again.`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), ms)
      stream.next().then(
        (result) => { clearTimeout(timer); resolve(result) },
        (err)    => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))) },
      )
    })
  }

  try {
    let first = true
    while (true) {
      const result = await nextWithIdleTimeout(first)
      if (result.done) break
      first = false
      code += result.value
      emit({ type: 'token', text: result.value })
    }
  } catch (err) {
    try { await stream.return?.(undefined) } catch { /* ignore — best-effort cleanup */ }
    throw err
  }

  return code
}

// ─── Self-check loop (max 2 passes) ──────────────────────────────────────────

// Sentinel text written by parseSelfCheckOutput when the model returns non-JSON.
// Detected here so we retry the API call instead of treating it as a code issue.
const PARSE_FAILURE_HINT = 'Retry the self-check'

function isParseFailure(output: SelfCheckOutput): boolean {
  return (
    !output.all_clear &&
    output.issues.length === 1 &&
    output.issues[0].suggested_fix === PARSE_FAILURE_HINT
  )
}

async function runSelfCheckPass(
  primary:        ModelAdapter,
  code:           string,
  ctx:            PipelineContext,
  pass:           1 | 2,
  projectId:      string,
  sessionId:      string,
  emit:           (event: SSEEvent) => void,
  previousIssues?: import('@/types').SelfCheckIssue[],
): Promise<{ code: string; output: SelfCheckOutput }> {
  // Self-check is a first-pass quality gate — the reviewer is the critical gate.
  // If the model returns empty responses or consistently fails, skip rather than
  // crashing the whole pipeline. The reviewer will catch what self-check missed.
  let selfCheckOutput: SelfCheckOutput
  try {
    selfCheckOutput = await retryWithTimeout(
      () => primary.selfCheck(code, ctx.spec, pass, previousIssues),
      { timeoutMs: TIMEOUT_DEFAULT_MS, label: `phase3:selfCheck:pass${pass}` },
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[selfCheck] pass ${pass} failed after retries — skipping (${reason})`)
    const skipped: SelfCheckOutput = {
      pass, issues: [], all_clear: true,
      reasoning: 'Self-check skipped — model returned empty/invalid response. Reviewer will catch issues.',
    }
    emit({ type: 'self_check_done', output: skipped })
    return { code, output: skipped }
  }

  // Model returned non-JSON — retry the self-check call (not a code patch).
  // If the retry also fails to parse, treat as all_clear and hand off to reviewer.
  if (isParseFailure(selfCheckOutput)) {
    try {
      const retried = await retryWithTimeout(
        () => primary.selfCheck(code, ctx.spec, pass, previousIssues),
        { timeoutMs: TIMEOUT_DEFAULT_MS, maxAttempts: 2, label: `phase3:selfCheck:pass${pass}:retry` },
      )
      selfCheckOutput = isParseFailure(retried)
        ? { ...retried, all_clear: true, issues: [], reasoning: 'Self-check parse failed after retry — proceeding to reviewer' }
        : retried
    } catch {
      selfCheckOutput = { pass, issues: [], all_clear: true,
        reasoning: 'Self-check retry failed — proceeding to reviewer' }
    }
  }

  const costUsd = primary.estimateCost(
    estimateTokens(code) + estimateTokens(JSON.stringify(ctx.spec)),
    estimateTokens(JSON.stringify(selfCheckOutput)),
  )

  await logSelfCheck(projectId, sessionId, selfCheckOutput, costUsd, primary.getProvider())
  emit({ type: 'self_check_done', output: selfCheckOutput })

  if (selfCheckOutput.all_clear || selfCheckOutput.issues.length === 0) {
    return { code, output: selfCheckOutput }
  }

  // Issues found — patch the code using the self-check issues as hints
  // Reuse the PATCH MODE path in buildGenerationPrompt
  const patchReview: ReviewPayload = {
    consensus:              false,
    round:                  pass,
    flags: selfCheckOutput.issues.map((issue, i) => ({
      id:               `sc-${pass}-${i}`,
      severity:         issue.severity === 'high' ? 'HIGH' : issue.severity === 'medium' ? 'MEDIUM' : 'LOW',
      category:         'bug' as const,
      description:      issue.description,
      pseudo_code_hint: issue.suggested_fix,
      location:         issue.location,
    })),
    critical_bugs:          selfCheckOutput.issues.filter(i => i.severity === 'high').map(i => i.description),
    logic_errors:           selfCheckOutput.issues.filter(i => i.severity === 'medium').map(i => i.description),
    edge_cases_missed:      [],
    pseudo_code_hints:      selfCheckOutput.issues.map(i => i.suggested_fix),
    reasoning:              selfCheckOutput.reasoning,
    dependencies_rechecked: false,
  }

  const patchPrompt = buildGenerationPrompt(ctx, { code, review: patchReview })
  const patchedCode = await generateCode(primary, patchPrompt, ctx, emit)

  return { code: patchedCode, output: selfCheckOutput }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export interface Phase3GenerateResult {
  code:            string
  selfCheckOutput: SelfCheckOutput
  tokensOut:       number
  costUsd:         number
}

/**
 * Phase 3 — Code generation + self-check.
 *
 * 1. Generate code (streaming) — normal mode or PATCH MODE if patchReview provided.
 * 2. Self-check pass 1: if issues, patch and self-check pass 2.
 * 3. Never exceeds 2 self-check passes — architecture rule.
 * 4. Returns final code regardless of remaining issues (reviewer handles next).
 */
export async function runPhase3Generate(
  projectId:     string,
  sessionId:     string,
  round:         number,
  ctx:           PipelineContext,
  primary:       ModelAdapter,
  emit:          (event: SSEEvent) => void,
  patchReview?:  ReviewPayload,
  previousCode?: string,          // required when patchReview is set — the code to patch
): Promise<Phase3GenerateResult> {
  await logPhaseStart(projectId, sessionId, 'phase3_generating', 'Phase 3: Code Generation')
  emit({ type: 'phase_change', phase: 'phase3_generating' })
  await logGenerationStart(projectId, sessionId, round, primary.getProvider())

  // Patch mode: reviewer found issues — send the previous code + specific flags back to
  // the primary so it makes targeted edits instead of regenerating from scratch.
  // previousCode MUST be the actual generated code, not the task description.
  const prompt = buildGenerationPrompt(
    ctx,
    patchReview && previousCode ? { code: previousCode, review: patchReview } : undefined,
  )

  // Streaming generation: no retry — a mid-stream retry would emit duplicate tokens.
  // Idle timeout is enforced inside generateCode (90s per token, not total).
  let code = await generateCode(primary, prompt, ctx, emit)

  const tokensOut = estimateTokens(code)
  const costUsd   = primary.estimateCost(estimateTokens(prompt), tokensOut)

  await logGenerationDone(projectId, sessionId, round, code.length, tokensOut, costUsd, primary.getProvider())

  emit({ type: 'phase_change', phase: 'phase3_self_check' })

  // ─── Self-check pass 1 ───────────────────────────────────────────────────────

  let selfCheckOutput: SelfCheckOutput
  const pass1 = await runSelfCheckPass(primary, code, ctx, 1, projectId, sessionId, emit)
  code            = pass1.code
  selfCheckOutput = pass1.output

  // ─── Self-check pass 2 (only if pass 1 found issues) ────────────────────────

  if (!pass1.output.all_clear && pass1.output.issues.length > 0 && MAX_SELF_CHECK_PASSES >= 2) {
    const pass2 = await runSelfCheckPass(primary, code, ctx, 2, projectId, sessionId, emit, pass1.output.issues)
    code            = pass2.code
    selfCheckOutput = pass2.output
  }

  return { code, selfCheckOutput, tokensOut, costUsd }
}
