import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { getSessionState } from '@/lib/pipeline/orchestrator'
import { readOutputFile, listOutputFiles } from '@/lib/memory/filesystem'
import { getSessionSummary } from '@/lib/conversation/event-log'
import type { ApiResponse } from '@/types'

// GET /api/output/:sessionId
// Returns the consensus-validated output for a completed pipeline session.
// Includes the code files, review payload, and session summary.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId: clerkUserId } = await auth()
    if (!clerkUserId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const { sessionId } = await params
    const state = await getSessionState(sessionId)
    if (!state) return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 })
    if (state.userId !== clerkUserId) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

    if (!state.output) {
      // Session exists but pipeline hasn't produced consensus output yet
      return NextResponse.json(
        { success: false, error: `No output yet — pipeline is in phase "${state.phase}"` },
        { status: 202 },  // 202 Accepted: pipeline running, check back later
      )
    }

    // Read all output files from the local filesystem
    const projectId = state.projectId
    const filenames  = await listOutputFiles(projectId)
    const files: Record<string, string> = {}
    await Promise.all(
      filenames.map(async (name) => {
        try {
          files[name] = await readOutputFile(projectId, name)
        } catch { /* skip unreadable files */ }
      }),
    )

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
