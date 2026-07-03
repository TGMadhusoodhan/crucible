import { logGenerationDone, logGenerationStart, logPhaseStart, logSelfCheck } from '@/lib/memory/session-log'
import { buildGenerationPrompt } from '@/lib/adapters/base'
import { dbg } from '@/lib/debug'
import { retryWithTimeout, TIMEOUT_DEFAULT_MS } from '@/lib/utils/retry'
import { estimateTokens } from '@/lib/utils/tokens'
import type {
  ModelAdapter,
  PipelineContext,
  ReviewPayload,
  SelfCheckIssue,
  SelfCheckOutput,
  SSEEvent,
} from '@/types'

// Architecture rule: max 2 self-check passes — enforced here.
const MAX_SELF_CHECK_PASSES = 2

// Two-tier idle timeouts for streaming generation.
// First token: model may think silently before first token (reasoning models).
// Inter-token: once streaming, long gaps mean a real hang.
const FIRST_TOKEN_TIMEOUT_MS = 300_000  // 5 min — generous for reasoning models
const INTER_TOKEN_TIMEOUT_MS =  60_000  // 1 min between tokens

// ─── Streaming code generation with idle timeout ──────────────────────────────

async function generateCode(
  primary: ModelAdapter,
  prompt:  string,
  ctx:     PipelineContext,
  emit:    (event: SSEEvent) => void,
): Promise<string> {
  const stream = primary.generate(prompt, ctx)
  let code = ''

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

const PARSE_FAILURE_HINT = 'Retry the self-check'

function isParseFailure(output: SelfCheckOutput): boolean {
  return (
    !output.all_clear &&
    output.issues.length === 1 &&
    output.issues[0].suggested_fix === PARSE_FAILURE_HINT
  )
}

async function runSelfCheckPass(
  primary:         ModelAdapter,
  code:            string,
  ctx:             PipelineContext,
  pass:            1 | 2,
  projectId:       string,
  sessionId:       string,
  emit:            (event: SSEEvent) => void,
  previousIssues?: SelfCheckIssue[],
): Promise<{ code: string; output: SelfCheckOutput }> {
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

// ─── Multi-file output parser ─────────────────────────────────────────────────

export function parseMultiFileOutput(raw: string): Record<string, string> {
  let text = raw.trim()
  const outerFence = text.match(/^```[a-z]*\r?\n([\s\S]*?)```\s*$/)
  if (outerFence?.[1]) text = outerFence[1]

  const files: Record<string, string> = {}
  const pattern = /=== FILE: (.+?) ===\r?\n([\s\S]*?)=== \/FILE ===/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const filename = match[1].trim()
    const content  = match[2]
    if (filename) files[filename] = content
  }
  return Object.keys(files).length > 0 ? files : { 'output.txt': raw }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export interface Phase3GenerateResult {
  code:            string
  files:           Record<string, string>
  selfCheckOutput: SelfCheckOutput
  tokensOut:       number
  costUsd:         number
}

/**
 * Phase 3 — Code generation + self-check.
 *
 * 1. Generate code (streaming).
 * 2. Self-check pass 1: if issues found, patch and self-check pass 2.
 * 3. Never exceeds 2 self-check passes — architecture rule.
 * 4. Returns final code regardless of remaining issues (reviewer handles next).
 */
export async function runPhase3Generate(
  projectId:  string,
  sessionId:  string,
  round:      number,
  ctx:        PipelineContext,
  primary:    ModelAdapter,
  emit:       (event: SSEEvent) => void,
): Promise<Phase3GenerateResult> {
  dbg.gen('starting generation', {
    generator: `${primary.getProvider()}:${primary.getModelId()}`,
    round,
  })

  await logPhaseStart(projectId, sessionId, 'phase3_generating', 'Phase 3: Code Generation')
  emit({ type: 'phase_change', phase: 'phase3_generating' })
  await logGenerationStart(projectId, sessionId, round, primary.getProvider())

  const prompt = buildGenerationPrompt(ctx)

  dbg.gen('streaming generation started', { generator: `${primary.getProvider()}:${primary.getModelId()}` })
  let code = await generateCode(primary, prompt, ctx, emit)
  dbg.gen('streaming generation done', { codeLen: code.length })

  const tokensOut = estimateTokens(code)
  const costUsd   = primary.estimateCost(estimateTokens(prompt), tokensOut)

  await logGenerationDone(projectId, sessionId, round, code.length, tokensOut, costUsd, primary.getProvider())

  emit({ type: 'phase_change', phase: 'phase3_self_check' })
  dbg.selfcheck('starting self-check pass 1', { checker: `${primary.getProvider()}:${primary.getModelId()}` })

  let selfCheckOutput: SelfCheckOutput
  const pass1 = await runSelfCheckPass(primary, code, ctx, 1, projectId, sessionId, emit)
  code            = pass1.code
  selfCheckOutput = pass1.output
  dbg.selfcheck('pass 1 done', { allClear: pass1.output.all_clear, issues: pass1.output.issues.length })

  if (!pass1.output.all_clear && pass1.output.issues.length > 0 && MAX_SELF_CHECK_PASSES >= 2) {
    dbg.selfcheck('pass 1 found issues — running pass 2', { issues: pass1.output.issues.map(i => i.severity) })
    const pass2 = await runSelfCheckPass(primary, code, ctx, 2, projectId, sessionId, emit, pass1.output.issues)
    code            = pass2.code
    selfCheckOutput = pass2.output
    dbg.selfcheck('pass 2 done', { allClear: pass2.output.all_clear, issues: pass2.output.issues.length })
  }

  const files = parseMultiFileOutput(code)
  dbg.gen('generation complete', { files: Object.keys(files), totalCodeLen: code.length })
  return { code, files, selfCheckOutput, tokensOut, costUsd }
}
