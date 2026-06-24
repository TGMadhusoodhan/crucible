import { NextResponse } from 'next/server'
import { getProjectOutput } from '@/lib/pipeline/orchestrator'
import type { ApiResponse } from '@/types'

// GET /api/projects/:id/output
// Returns the last ConsensusOutput + spec stored for this project (from filesystem).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<ApiResponse>> {
  try {
    const { id: projectId } = await params
    if (!projectId) return NextResponse.json({ success: false, error: 'Missing project id' }, { status: 400 })

    const stored = await getProjectOutput('local', projectId)
    return NextResponse.json({ success: true, data: stored ?? null })
  } catch (err) {
    console.error('GET /api/projects/[id]/output:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
