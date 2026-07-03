import { logPhaseStart, logThinkingDone } from '@/lib/memory/session-log'
import { retryWithTimeout, TIMEOUT_THINK_MS } from '@/lib/utils/retry'
import { dbg } from '@/lib/debug'
import type { ModelAdapter, Provider, SSEEvent, ThinkingOutput } from '@/types'

function thinkFallback(provider: Provider, modelId: string): ThinkingOutput {
  return {
    understood_as: 'Analysis unavailable — model timed out',
    assumptions: [], questions: [], recommended_approach: '',
    risks: [], provider, model_id: modelId, tokens_used: 0,
  }
}

export interface Phase1Result {
  primary:     ThinkingOutput
  reviewer:    ThinkingOutput
  totalTokens: number
}

/**
 * Phase 1: Both models think independently and in parallel.
 * Neither model sees the other's output during this phase.
 * Max 60 seconds per model call (TIMEOUT_DEFAULT_MS).
 */
export async function runPhase1Thinking(
  projectId:       string,
  sessionId:       string,
  taskDescription: string,
  primary:         ModelAdapter,
  reviewer:        ModelAdapter,
  emit:            (event: SSEEvent) => void,
  contextText?:    string,
): Promise<Phase1Result> {
  await logPhaseStart(projectId, sessionId, 'phase1_thinking', 'Phase 1: Parallel Thinking')
  emit({ type: 'phase_change', phase: 'phase1_thinking' })

  dbg.phase1('firing parallel think calls', {
    primary:  `${primary.getProvider()}:${primary.getModelId()}`,
    reviewer: `${reviewer.getProvider()}:${reviewer.getModelId()}`,
  })

  const [primaryOutput, reviewerOutput] = await Promise.all([
    retryWithTimeout(
      () => primary.think(taskDescription, contextText),
      { timeoutMs: TIMEOUT_THINK_MS, label: 'phase1:primary:think' },
    ).then((output) => {
      dbg.phase1('primary think done', { tokens: output.tokens_used, questions: output.questions.length, understood: output.understood_as.slice(0, 80) })
      emit({ type: 'thinking_done', actor: 'primary', output })
      void logThinkingDone(projectId, sessionId, 'primary', output)
      return output
    }).catch((err) => {
      dbg.phase1('primary think FAILED — using fallback', { err: err instanceof Error ? err.message : String(err) })
      console.warn('[phase1] primary think failed, using fallback:', err instanceof Error ? err.message : err)
      const fallback = thinkFallback(primary.getProvider(), primary.getModelId())
      emit({ type: 'thinking_done', actor: 'primary', output: fallback })
      return fallback
    }),
    retryWithTimeout(
      () => reviewer.think(taskDescription, contextText),
      { timeoutMs: TIMEOUT_THINK_MS, label: 'phase1:reviewer:think' },
    ).then((output) => {
      dbg.phase1('reviewer think done', { tokens: output.tokens_used, questions: output.questions.length, understood: output.understood_as.slice(0, 80) })
      emit({ type: 'thinking_done', actor: 'reviewer', output })
      void logThinkingDone(projectId, sessionId, 'reviewer', output)
      return output
    }).catch((err) => {
      dbg.phase1('reviewer think FAILED — using fallback', { err: err instanceof Error ? err.message : String(err) })
      console.warn('[phase1] reviewer think failed, using fallback:', err instanceof Error ? err.message : err)
      const fallback = thinkFallback(reviewer.getProvider(), reviewer.getModelId())
      emit({ type: 'thinking_done', actor: 'reviewer', output: fallback })
      return fallback
    }),
  ])

  dbg.phase1('both think calls complete', {
    primaryTokens: primaryOutput.tokens_used,
    reviewerTokens:reviewerOutput.tokens_used,
  })

  return { primary: primaryOutput, reviewer: reviewerOutput,
    totalTokens: primaryOutput.tokens_used + reviewerOutput.tokens_used }
}
