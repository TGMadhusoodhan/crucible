import { auth } from '@clerk/nextjs/server'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSessionState, playSession } from '@/lib/pipeline/orchestrator'
import type { ApiResponse } from '@/types'

const schema = z.object({ sessionId: z.string().min(1) })

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId: clerkUserId } = await auth()
    if (!clerkUserId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const parsed = schema.safeParse(await request.json() as unknown)
    if (!parsed.success) return NextResponse.json({ success: false, error: 'Missing sessionId' }, { status: 400 })

    const { sessionId } = parsed.data
    const state = await getSessionState(sessionId)
    if (!state) return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 })
    if (state.userId !== clerkUserId) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

    await playSession(sessionId)
    // After play, client reconnects to GET /api/pipeline/stream to resume execution
    return NextResponse.json({ success: true, data: { nextAction: 'reconnect_stream' } })
  } catch (err) {
    console.error('POST /api/pipeline/play:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(): Promise<NextResponse<ApiResponse>> {
  return NextResponse.json({ success: false, error: 'Use POST' }, { status: 405 })
}
