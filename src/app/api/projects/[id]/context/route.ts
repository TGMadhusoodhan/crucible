import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { loadProjectContext } from '@/lib/workspace/memory'
import type { ApiResponse, ProjectContext } from '@/types'

const EMPTY_CONTEXT: ProjectContext = {
  specSummary:    '',
  decisions:      [],
  fileIndex:      [],
  driftedFiles:   [],
  untrackedFiles: [],
  crucibleMd:     null,
  mode:           'new',
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<ApiResponse<ProjectContext>>> {
  try {
    const { id } = await params
    const [project] = await db
      .select({ workspaceDir: schema.projects.workspaceDir })
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .limit(1)

    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 })
    }

    if (!project.workspaceDir) {
      return NextResponse.json({ success: true, data: EMPTY_CONTEXT })
    }

    const context = loadProjectContext(project.workspaceDir)
    return NextResponse.json({ success: true, data: context })
  } catch (err) {
    console.error('GET /api/projects/[id]/context:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
