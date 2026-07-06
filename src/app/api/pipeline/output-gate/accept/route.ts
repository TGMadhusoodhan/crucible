import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { acceptOutputFile } from '@/lib/pipeline/orchestrator'
import { captureApiError } from '@/lib/sentry'
import type { ApiResponse } from '@/types'

const schema = z.object({
  sessionId: z.string().min(1),
  filename:  z.string().min(1),
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

    const { sessionId, filename } = parsed.data
    const { done, push } = await acceptOutputFile(sessionId, filename)
    return NextResponse.json({ success: true, data: { done, push } })
  } catch (err) {
    console.error('POST /api/pipeline/output-gate/accept:', err instanceof Error ? err.message : err)
    captureApiError(err, 'POST /api/pipeline/output-gate/accept')
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(): Promise<NextResponse<ApiResponse>> {
  return NextResponse.json({ success: false, error: 'Use POST' }, { status: 405 })
}
