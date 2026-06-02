import { auth } from '@clerk/nextjs/server'
import { getSessionState, runPipeline } from '@/lib/pipeline/orchestrator'
import { serializeHeartbeat } from '@/lib/conversation/event-log'
import { captureApiError } from '@/lib/sentry'
import type { SSEEvent } from '@/types'

const HEARTBEAT_MS = 15_000  // keep connection alive while pipeline is running

// GET /api/pipeline/stream?sessionId=xxx
// SSE stream: runs the pipeline and emits events directly to the client.
// The pipeline is re-entrant — it resumes from wherever the session state left off.
// Returns when the pipeline reaches a human-input gate, completes, or errors.
// The client reconnects after submitting answers / confirming spec / resolving conflict.
export async function GET(request: Request): Promise<Response> {
  const { userId: clerkUserId } = await auth()
  if (!clerkUserId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const sessionId = searchParams.get('sessionId')
  if (!sessionId) {
    return new Response('Missing sessionId', { status: 400 })
  }

  // Verify session belongs to this user
  const state = await getSessionState(sessionId)
  if (!state) {
    return new Response('Session not found', { status: 404 })
  }
  if (state.userId !== clerkUserId) {
    return new Response('Forbidden', { status: 403 })
  }

  // Phases where we don't need to run the pipeline — client is waiting to give input
  const GATE_PHASES = new Set([
    'phase2_answering', 'phase2_spec_confirm', 'conflict_escalated',
    'paused', 'stopped', 'complete', 'error',
  ])

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false

      const close = () => {
        if (closed) return
        closed = true
        try { controller.close() } catch { /* already closed */ }
      }

      // Abort when client disconnects
      request.signal.addEventListener('abort', close)

      const send = (event: SSEEvent): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          closed = true
        }
      }

      const sendRaw = (text: string): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          closed = true
        }
      }

      // If the session is at a gate, tell the client and close immediately.
      // This handles the case where the client reconnects after submitting input
      // but the state was already advanced by the message route.
      const currentState = await getSessionState(sessionId)
      if (!currentState) { close(); return }

      if (GATE_PHASES.has(currentState.phase) && currentState.phase !== 'paused') {
        // If paused: client reconnects after play — we should run the pipeline
        // For all other gate phases: just report current state and close
        send({ type: 'phase_change', phase: currentState.phase })
        close()
        return
      }

      // Start heartbeat — keeps the SSE connection alive during long model calls
      const heartbeatTimer = setInterval(() => {
        sendRaw(serializeHeartbeat())
      }, HEARTBEAT_MS)

      try {
        // Run pipeline — it will emit events via our send function (zero-latency, no polling)
        await runPipeline(sessionId, send)

        // Pipeline returned — check why
        const finalState = await getSessionState(sessionId)
        if (finalState && !GATE_PHASES.has(finalState.phase)) {
          // Unexpected exit — shouldn't happen, but emit an error to inform the client
          send({ type: 'error', message: 'Pipeline exited unexpectedly', phase: finalState.phase })
        } else if (finalState && finalState.phase !== 'error') {
          // Reached a human-input gate — tell the client which phase we stopped at.
          // Skip 'error': the pipeline already sent an explicit { type: 'error' } event.
          // Sending phase_change: error here would overwrite the error message with null
          // via the SET_PHASE reducer (which clears error on every phase transition).
          send({ type: 'phase_change', phase: finalState.phase })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Pipeline error'
        console.error('[stream] pipeline error:', message)
        captureApiError(err, `GET /api/pipeline/stream [phase: ${currentState.phase}]`, currentState.userId)
        send({ type: 'error', message, phase: currentState.phase })
      } finally {
        clearInterval(heartbeatTimer)
        close()
      }
    },

    cancel() {
      // Client disconnected cleanly — nothing to do; the abort listener handles it
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',  // Disable nginx buffering for proxied deployments
    },
  })
}

export async function POST(): Promise<Response> {
  return new Response('Use GET for the SSE stream', { status: 405 })
}
