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
  r1:          ThinkingOutput
  r2:          ThinkingOutput
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
  r1Adapter:       ModelAdapter,
  r2Adapter:       ModelAdapter,
  emit:            (event: SSEEvent) => void,
  contextText?:    string,
): Promise<Phase1Result> {
  await logPhaseStart(projectId, sessionId, 'phase1_thinking', 'Phase 1: Parallel Thinking')
  emit({ type: 'phase_change', phase: 'phase1_thinking' })

  dbg.phase1('firing parallel think calls', {
    r1: `${r1Adapter.getProvider()}:${r1Adapter.getModelId()}`,
    r2: `${r2Adapter.getProvider()}:${r2Adapter.getModelId()}`,
  })

  const [r1Output, r2Output] = await Promise.all([
    retryWithTimeout(
      () => r1Adapter.think(taskDescription, contextText),
      { timeoutMs: TIMEOUT_THINK_MS, label: 'phase1:r1:think' },
    ).then((output) => {
      dbg.phase1('r1 think done', { tokens: output.tokens_used, questions: output.questions.length, understood: output.understood_as.slice(0, 80) })
      emit({ type: 'thinking_done', actor: 'r1', output })
      void logThinkingDone(projectId, sessionId, 'r1', output)
      return output
    }).catch((err) => {
      dbg.phase1('r1 think FAILED — using fallback', { err: err instanceof Error ? err.message : String(err) })
      console.warn('[phase1] r1 think failed, using fallback:', err instanceof Error ? err.message : err)
      const fallback = thinkFallback(r1Adapter.getProvider(), r1Adapter.getModelId())
      emit({ type: 'thinking_done', actor: 'r1', output: fallback })
      return fallback
    }),
    retryWithTimeout(
      () => r2Adapter.think(taskDescription, contextText),
      { timeoutMs: TIMEOUT_THINK_MS, label: 'phase1:r2:think' },
    ).then((output) => {
      dbg.phase1('r2 think done', { tokens: output.tokens_used, questions: output.questions.length, understood: output.understood_as.slice(0, 80) })
      emit({ type: 'thinking_done', actor: 'r2', output })
      void logThinkingDone(projectId, sessionId, 'r2', output)
      return output
    }).catch((err) => {
      dbg.phase1('r2 think FAILED — using fallback', { err: err instanceof Error ? err.message : String(err) })
      console.warn('[phase1] r2 think failed, using fallback:', err instanceof Error ? err.message : err)
      const fallback = thinkFallback(r2Adapter.getProvider(), r2Adapter.getModelId())
      emit({ type: 'thinking_done', actor: 'r2', output: fallback })
      return fallback
    }),
  ])

  dbg.phase1('both think calls complete', {
    r1Tokens: r1Output.tokens_used,
    r2Tokens: r2Output.tokens_used,
  })

  return { r1: r1Output, r2: r2Output,
    totalTokens: r1Output.tokens_used + r2Output.tokens_used }
}
