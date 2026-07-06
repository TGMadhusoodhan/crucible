import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { readOutputFile, writeOutput } from '@/lib/memory/filesystem'
import { getSessionState } from '@/lib/pipeline/orchestrator'
import { getAdapter } from '@/lib/adapters'
import type { ApiResponse } from '@/types'

const postSchema = z.object({
  prompt:    z.string().min(1).max(4000),
  sessionId: z.string().min(1),
})

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; filepath: string[] }> },
): Promise<NextResponse<ApiResponse<{ content: string }>>> {
  try {
    const { projectId, filepath } = await params
    const filename = filepath.join('/')
    const content  = readOutputFile(projectId, filename)
    return NextResponse.json({ success: true, data: { content } })
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : 'Not found' }, { status: 404 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; filepath: string[] }> },
): Promise<NextResponse<ApiResponse<{ content: string }>>> {
  try {
    const { projectId, filepath } = await params
    const filename = filepath.join('/')

    const parsed = postSchema.safeParse(await request.json() as unknown)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      )
    }

    const { prompt, sessionId } = parsed.data

    // Read current file content
    let currentCode = ''
    try { currentCode = readOutputFile(projectId, filename) } catch { /* new file */ }

    const state = await getSessionState(sessionId)
    if (!state) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 })
    }

    const coderAdapter = getAdapter(state.config.coderProvider, state.config.coderModelId, state.config.coderApiKey)
    const { code: newCode } = await coderAdapter.fixFile(filename, currentCode, prompt, () => {})

    // Write updated file to disk
    writeOutput(projectId, filename, newCode)

    return NextResponse.json({ success: true, data: { content: newCode } })
  } catch (err) {
    console.error('POST /api/files:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 })
  }
}
