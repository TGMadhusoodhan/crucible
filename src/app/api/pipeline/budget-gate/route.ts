import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSessionState, resolveBudgetGate } from '@/lib/pipeline/orchestrator'
import { captureApiError } from '@/lib/sentry'
import type { ApiResponse } from '@/types'

const schema = z.object({
  sessionId: z.string().min(1),
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

    const { sessionId } = parsed.data
    const state = await getSessionState(sessionId)
    if (!state) return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 })

    if (state.phase !== 'phase3_budget_gate') {
      return NextResponse.json(
        { success: false, error: `Cannot resolve budget gate in phase "${state.phase}"` },
        { status: 409 },
      )
    }

    await resolveBudgetGate(sessionId)
    return NextResponse.json({ success: true, data: { nextAction: 'reconnect_stream' } })
  } catch (err) {
    console.error('POST /api/pipeline/budget-gate:', err instanceof Error ? err.message : err)
    captureApiError(err, 'POST /api/pipeline/budget-gate')
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(): Promise<NextResponse<ApiResponse>> {
  return NextResponse.json({ success: false, error: 'Use POST' }, { status: 405 })
}
