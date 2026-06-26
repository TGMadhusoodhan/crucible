import { getSessionState, runPipeline } from '@/lib/pipeline/orchestrator'
import { serializeHeartbeat } from '@/lib/conversation/event-log'
import { captureApiError } from '@/lib/sentry'
import type { SSEEvent } from '@/types'

const HEARTBEAT_MS = 15_000

export async function GET(request: Request): Promise<Response> {
  const userId = 'local'

  const { searchParams } = new URL(request.url)
  const sessionId = searchParams.get('sessionId')
  if (!sessionId) {
    return new Response('Missing sessionId', { status: 400 })
  }

  const state = await getSessionState(sessionId)
  if (!state) {
    return new Response('Session not found', { status: 404 })
  }

  const GATE_PHASES = new Set([
    'phase2_answering', 'phase2_spec_confirm', 'conflict_escalated',
    'paused', 'stopped', 'complete', 'error',
    // phase3_reviewing is a split point: generation done, reconnect for review + edit + verify + dialogue
    'phase3_reviewing',
    // file gate: pipeline pauses here for per-file human review
    'phase3_file_gate', 'phase3_file_feedback',
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

      const currentState = await getSessionState(sessionId)
      if (!currentState) { close(); return }

      const isHumanGate = GATE_PHASES.has(currentState.phase)
        && currentState.phase !== 'paused'
        && currentState.phase !== 'phase3_reviewing'
      if (isHumanGate) {
        send({ type: 'phase_change', phase: currentState.phase })
        close()
        return
      }

      const heartbeatTimer = setInterval(() => {
        sendRaw(serializeHeartbeat())
      }, HEARTBEAT_MS)

      try {
        await runPipeline(sessionId, send)

        const finalState = await getSessionState(sessionId)
        if (finalState && !GATE_PHASES.has(finalState.phase)) {
          send({ type: 'error', message: 'Pipeline exited unexpectedly', phase: finalState.phase })
        } else if (finalState && finalState.phase !== 'error') {
          send({ type: 'phase_change', phase: finalState.phase })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Pipeline error'
        console.error('[stream] pipeline error:', message)
        captureApiError(err, `GET /api/pipeline/stream [phase: ${currentState.phase}]`, userId)
        send({ type: 'error', message, phase: currentState.phase })
      } finally {
        clearInterval(heartbeatTimer)
        close()
      }
    },

    cancel() {},
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

export async function POST(): Promise<Response> {
  return new Response('Use GET for the SSE stream', { status: 405 })
}
