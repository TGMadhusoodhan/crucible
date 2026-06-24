import { NextResponse } from 'next/server'
import { getSessionState } from '@/lib/pipeline/orchestrator'
import { readOutputFile, listOutputFiles } from '@/lib/memory/filesystem'
import { getSessionSummary } from '@/lib/conversation/event-log'
import type { ApiResponse } from '@/types'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse<ApiResponse>> {
  try {
    const { sessionId } = await params
    const state = await getSessionState(sessionId)
    if (!state) return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 })

    if (!state.output) {
      return NextResponse.json(
        { success: false, error: `No output yet — pipeline is in phase "${state.phase}"` },
        { status: 202 },
      )
    }

    const projectId = state.projectId
    const filenames  = listOutputFiles(projectId)
    const files: Record<string, string> = {}
    for (const name of filenames) {
      try { files[name] = readOutputFile(projectId, name) } catch { /* skip */ }
    }

    const summary = await getSessionSummary(projectId)

    return NextResponse.json({
      success: true,
      data: {
        sessionId,
        projectId,
        output:     state.output,
        files,
        summary,
        phase:      state.phase,
        round:      state.round,
        spec:       state.spec,
      },
    })
  } catch (err) {
    console.error('GET /api/output/[sessionId]:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(): Promise<NextResponse<ApiResponse>> {
  return NextResponse.json({ success: false, error: 'Use GET' }, { status: 405 })
}
