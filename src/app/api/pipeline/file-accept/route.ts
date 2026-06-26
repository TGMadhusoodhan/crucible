import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSessionState, saveSessionState } from '@/lib/pipeline/orchestrator'
import { writeOutput } from '@/lib/memory/filesystem'
import type { ApiResponse } from '@/types'

const schema = z.object({
  sessionId: z.string().min(1),
  filename:  z.string().min(1),
  code:      z.string(),
})

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<{ fileIndex: number; done: boolean }>>> {
  try {
    const parsed = schema.safeParse(await request.json() as unknown)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      )
    }

    const { sessionId, filename, code } = parsed.data
    const state = await getSessionState(sessionId)
    if (!state) return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 })

    if (state.phase !== 'phase3_file_gate') {
      return NextResponse.json(
        { success: false, error: `Session is not at a file gate (current: ${state.phase})` },
        { status: 409 },
      )
    }

    // Write the accepted file to the output layer
    await writeOutput(state.projectId, filename, code)

    // Advance the file index
    const nextIndex  = (state.currentFileIndex ?? 0) + 1
    const totalFiles = Object.keys(state.generatedFiles ?? {}).length
    const done       = nextIndex >= totalFiles

    state.currentFileIndex = nextIndex
    if (done) state.phase = 'complete'
    await saveSessionState(state)

    return NextResponse.json({ success: true, data: { fileIndex: nextIndex, done } })
  } catch (err) {
    console.error('POST /api/pipeline/file-accept:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
