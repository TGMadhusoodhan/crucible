import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSessionState, stopSession } from '@/lib/pipeline/orchestrator'
import type { ApiResponse } from '@/types'

const schema = z.object({ sessionId: z.string().min(1) })

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const parsed = schema.safeParse(await request.json() as unknown)
    if (!parsed.success) return NextResponse.json({ success: false, error: 'Missing sessionId' }, { status: 400 })

    const { sessionId } = parsed.data
    const state = await getSessionState(sessionId)
    if (!state) return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 })

    await stopSession(sessionId)
    return NextResponse.json({ success: true, data: { phase: 'stopped' } })
  } catch (err) {
    console.error('POST /api/pipeline/stop:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(): Promise<NextResponse<ApiResponse>> {
  return NextResponse.json({ success: false, error: 'Use POST' }, { status: 405 })
}
