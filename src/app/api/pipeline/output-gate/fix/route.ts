import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { applyOutputFix } from '@/lib/pipeline/orchestrator'
import { captureApiError } from '@/lib/sentry'
import type { ApiResponse } from '@/types'

const schema = z.object({
  sessionId:   z.string().min(1),
  filename:    z.string().min(1),
  instruction: z.string().min(1).max(2000),
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

    const { sessionId, filename, instruction } = parsed.data
    const { code, modelId } = await applyOutputFix(sessionId, filename, instruction)
    return NextResponse.json({ success: true, data: { code, modelId } })
  } catch (err) {
    console.error('POST /api/pipeline/output-gate/fix:', err instanceof Error ? err.message : err)
    captureApiError(err, 'POST /api/pipeline/output-gate/fix')
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(): Promise<NextResponse<ApiResponse>> {
  return NextResponse.json({ success: false, error: 'Use POST' }, { status: 405 })
}
