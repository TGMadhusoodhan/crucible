import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSessionState, resolveArbitration } from '@/lib/pipeline/orchestrator'
import { captureApiError } from '@/lib/sentry'
import type { ApiResponse } from '@/types'

const schema = z.object({
  sessionId: z.string().min(1),
  filename:  z.string().min(1),
  choice:    z.enum(['r1', 'r2', 'accept', 'regenerate']),
  guidance:  z.string().max(2000).optional(),
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

    const { sessionId, filename, choice, guidance } = parsed.data
    const state = await getSessionState(sessionId)
    if (!state) return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 })

    if (state.phase !== 'phase3_arbitration') {
      return NextResponse.json(
        { success: false, error: `Cannot arbitrate in phase "${state.phase}"` },
        { status: 409 },
      )
    }

    await resolveArbitration(sessionId, filename, choice, guidance)
    return NextResponse.json({ success: true, data: { nextAction: 'reconnect_stream' } })
  } catch (err) {
    console.error('POST /api/pipeline/arbitration:', err instanceof Error ? err.message : err)
    captureApiError(err, 'POST /api/pipeline/arbitration')
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(): Promise<NextResponse<ApiResponse>> {
  return NextResponse.json({ success: false, error: 'Use POST' }, { status: 405 })
}
