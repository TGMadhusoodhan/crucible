import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import {
  getSessionState,
  submitAnswers,
  confirmSpec,
} from '@/lib/pipeline/orchestrator'
import { captureApiError } from '@/lib/sentry'
import type { ApiResponse } from '@/types'

const answersSchema = z.object({
  type:      z.literal('answers'),
  sessionId: z.string().min(1),
  answers:   z.record(z.string(), z.string()),
})

const confirmSpecSchema = z.object({
  type:      z.literal('confirm_spec'),
  sessionId: z.string().min(1),
})

const messageSchema = z.discriminatedUnion('type', [
  answersSchema,
  confirmSpecSchema,
])

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const body = await request.json() as unknown
    const parsed = messageSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      )
    }

    const msg = parsed.data
    const state = await getSessionState(msg.sessionId)
    if (!state) return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 })

    switch (msg.type) {
      case 'answers': {
        if (state.phase !== 'phase2_answering') {
          return NextResponse.json(
            { success: false, error: `Cannot submit answers in phase "${state.phase}"` },
            { status: 409 },
          )
        }
        await submitAnswers(msg.sessionId, msg.answers)
        return NextResponse.json({ success: true, data: { nextAction: 'reconnect_stream' } })
      }

      case 'confirm_spec': {
        if (state.phase !== 'phase2_confirm') {
          return NextResponse.json(
            { success: false, error: `Cannot confirm spec in phase "${state.phase}"` },
            { status: 409 },
          )
        }
        await confirmSpec(msg.sessionId)
        return NextResponse.json({ success: true, data: { nextAction: 'reconnect_stream' } })
      }
    }
  } catch (err) {
    console.error('POST /api/pipeline/message:', err instanceof Error ? err.message : err)
    captureApiError(err, 'POST /api/pipeline/message')
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(): Promise<NextResponse<ApiResponse>> {
  return NextResponse.json({ success: false, error: 'Use POST' }, { status: 405 })
}
