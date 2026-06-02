import * as Sentry from '@sentry/nextjs'
import type { PipelinePhase } from '@/types'

// ─── Pipeline error capture ───────────────────────────────────────────────────

export interface PipelineErrorContext {
  sessionId:  string
  projectId:  string
  userId:     string
  phase:      PipelinePhase
  round?:     number
  modelId?:   string
  provider?:  string
}

/**
 * Captures a pipeline error with full context.
 * Never logs API keys — they are never in scope at call sites.
 */
export function capturePipelineError(err: unknown, ctx: PipelineErrorContext): void {
  try {
    const error = err instanceof Error ? err : new Error(String(err))

    Sentry.withScope(scope => {
      scope.setTag('pipeline.phase',    ctx.phase)
      scope.setTag('pipeline.provider', ctx.provider ?? 'unknown')
      if (ctx.round !== undefined) scope.setTag('pipeline.round', String(ctx.round))

      scope.setContext('pipeline', {
        sessionId: ctx.sessionId,
        projectId: ctx.projectId,
        phase:     ctx.phase,
        round:     ctx.round,
        modelId:   ctx.modelId,
        provider:  ctx.provider,
      })

      scope.setUser({ id: ctx.userId })
      Sentry.captureException(error)
    })
  } catch {
    // Sentry internal failure — log locally but never let it break the pipeline
    console.warn('[sentry] capturePipelineError failed silently')
  }
}

// ─── API route error capture ──────────────────────────────────────────────────

export function captureApiError(err: unknown, route: string, userId?: string): void {
  try {
    const error = err instanceof Error ? err : new Error(String(err))
    Sentry.withScope(scope => {
      scope.setTag('api.route', route)
      if (userId) scope.setUser({ id: userId })
      Sentry.captureException(error)
    })
  } catch {
    console.warn('[sentry] captureApiError failed silently')
  }
}

// ─── Model adapter error capture ─────────────────────────────────────────────

export function captureAdapterError(
  err:      unknown,
  provider: string,
  method:   'think' | 'chat' | 'generate' | 'selfCheck' | 'review',
): void {
  try {
    const error = err instanceof Error ? err : new Error(String(err))
    Sentry.withScope(scope => {
      scope.setTag('adapter.provider', provider)
      scope.setTag('adapter.method',   method)
      Sentry.captureException(error)
    })
  } catch {
    console.warn('[sentry] captureAdapterError failed silently')
  }
}

// ─── Re-export common Sentry utilities ───────────────────────────────────────

export { Sentry }
