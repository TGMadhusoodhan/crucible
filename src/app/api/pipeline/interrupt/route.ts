import { auth } from '@clerk/nextjs/server'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSessionState, injectOverride } from '@/lib/pipeline/orchestrator'
import type { ApiResponse } from '@/types'

const schema = z.object({
  sessionId: z.string().min(1),
  message:   z.string().min(1).max(2000),
})

// POST /api/pipeline/interrupt
// Injects a HUMAN OVERRIDE into the session's pending override queue.
// The override is picked up at the start of the next generation round.
// This does NOT pause/stop the pipeline — it queues the override.
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

    const { sessionId, message } = parsed.data
    const state = await getSessionState(sessionId)
    if (!state) return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 })
    if (state.userId !== clerkUserId) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

    await injectOverride(sessionId, message)
    return NextResponse.json({ success: true, data: { queued: true } })
  } catch (err) {
    console.error('POST /api/pipeline/interrupt:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(): Promise<NextResponse<ApiResponse>> {
  return NextResponse.json({ success: false, error: 'Use POST' }, { status: 405 })
}
