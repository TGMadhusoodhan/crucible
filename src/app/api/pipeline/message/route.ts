import { auth } from '@clerk/nextjs/server'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import {
  getSessionState,
  submitAnswers,
  confirmSpec,
  resolveConflict,
} from '@/lib/pipeline/orchestrator'
import { captureApiError } from '@/lib/sentry'
import type { ApiResponse } from '@/types'

// ─── Request schemas ──────────────────────────────────────────────────────────

const answersSchema = z.object({
  type:      z.literal('answers'),
  sessionId: z.string().min(1),
  answers:   z.record(z.string(), z.string()),
})

const confirmSpecSchema = z.object({
  type:      z.literal('confirm_spec'),
  sessionId: z.string().min(1),
})

const resolveConflictSchema = z.object({
  type:            z.literal('resolve_conflict'),
  sessionId:       z.string().min(1),
  overrideMessage: z.string().min(1).max(2000),
})

const messageSchema = z.discriminatedUnion('type', [
  answersSchema,
  confirmSpecSchema,
  resolveConflictSchema,
])

// ─── Auth + session guard ─────────────────────────────────────────────────────

async function guardSession(clerkUserId: string, sessionId: string) {
  const state = await getSessionState(sessionId)
  if (!state) return { error: 'Session not found', status: 404, state: null }
  if (state.userId !== clerkUserId) return { error: 'Forbidden', status: 403, state: null }
  return { error: null, status: 200, state }
}

// POST /api/pipeline/message
// Three sub-actions unified under one route:
//   type='answers'          — submit question answers (phase2_answering → phase2_contradictions)
//   type='confirm_spec'     — approve the spec (phase2_spec_confirm → phase3_generating)
//   type='resolve_conflict' — human resolves model conflict (conflict_escalated → phase3_generating)
//
// After each action the session phase advances in Redis.
// The client then reconnects to GET /api/pipeline/stream to continue execution.
export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId: clerkUserId } = await auth()
    if (!clerkUserId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json() as unknown
    const parsed = messageSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      )
    }

    const msg = parsed.data
    const { error, status, state } = await guardSession(clerkUserId, msg.sessionId)
    if (error || !state) {
      return NextResponse.json({ success: false, error: error! }, { status })
    }

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
        if (state.phase !== 'phase2_spec_confirm') {
          return NextResponse.json(
            { success: false, error: `Cannot confirm spec in phase "${state.phase}"` },
            { status: 409 },
          )
        }
        await confirmSpec(msg.sessionId)
        return NextResponse.json({ success: true, data: { nextAction: 'reconnect_stream' } })
      }

      case 'resolve_conflict': {
        if (state.phase !== 'conflict_escalated') {
          return NextResponse.json(
            { success: false, error: `Cannot resolve conflict in phase "${state.phase}"` },
            { status: 409 },
          )
        }
        await resolveConflict(msg.sessionId, msg.overrideMessage)
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
