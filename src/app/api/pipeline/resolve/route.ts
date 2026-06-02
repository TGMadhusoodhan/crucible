import { auth } from '@clerk/nextjs/server'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSessionState, resolveConflict } from '@/lib/pipeline/orchestrator'
import type { ApiResponse } from '@/types'

const schema = z.object({
  sessionId:       z.string().min(1),
  overrideMessage: z.string().min(1).max(2000),
})

// POST /api/pipeline/resolve
// Human resolves an escalated model conflict.
// Equivalent to POST /api/pipeline/message with type='resolve_conflict'.
// Advances phase from conflict_escalated → phase3_generating.
// Client must reconnect to GET /api/pipeline/stream after calling this.
export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId: clerkUserId } = await auth()
    if (!clerkUserId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const parsed = schema.safeParse(await request.json() as unknown)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      )
    }

    const { sessionId, overrideMessage } = parsed.data
    const state = await getSessionState(sessionId)
    if (!state) return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 })
    if (state.userId !== clerkUserId) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

    if (state.phase !== 'conflict_escalated') {
      return NextResponse.json(
        { success: false, error: `Session is not in conflict_escalated phase (current: ${state.phase})` },
        { status: 409 },
      )
    }

    await resolveConflict(sessionId, overrideMessage)
    return NextResponse.json({ success: true, data: { nextAction: 'reconnect_stream' } })
  } catch (err) {
    console.error('POST /api/pipeline/resolve:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(): Promise<NextResponse<ApiResponse>> {
  return NextResponse.json({ success: false, error: 'Use POST' }, { status: 405 })
}
