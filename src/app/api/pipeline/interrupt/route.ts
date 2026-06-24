import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSessionState, injectOverride } from '@/lib/pipeline/orchestrator'
import type { ApiResponse } from '@/types'

const schema = z.object({
  sessionId: z.string().min(1),
  message:   z.string().min(1).max(2000),
})

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
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
