import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { decrypt } from '@/lib/crypto'
import { pushWorkspace } from '@/lib/workspace/github'
import { captureApiError } from '@/lib/sentry'
import type { ApiResponse } from '@/types'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<ApiResponse>> {
  try {
    const { id } = await params

    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .limit(1)
    if (!project) return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 })
    if (!project.workspaceDir) return NextResponse.json({ success: false, error: 'Project has no workspace' }, { status: 422 })
    if (!project.githubRepo) return NextResponse.json({ success: false, error: 'Project has no GitHub repo linked' }, { status: 422 })

    const [credRow] = await db
      .select({ encryptedKey: schema.apiCredentials.encryptedKey, isValid: schema.apiCredentials.isValid })
      .from(schema.apiCredentials)
      .where(eq(schema.apiCredentials.provider, 'github'))
      .limit(1)
    if (!credRow?.isValid) {
      return NextResponse.json({ success: false, error: 'No valid GitHub token — add one in Settings' }, { status: 422 })
    }

    let token: string
    try { token = decrypt(credRow.encryptedKey) } catch {
      return NextResponse.json({ success: false, error: 'Failed to decrypt GitHub token' }, { status: 500 })
    }

    const result = await pushWorkspace(
      project.workspaceDir,
      project.githubRepo,
      project.githubBranch ?? 'main',
      token,
    )

    return NextResponse.json({ success: true, data: result })
  } catch (err) {
    captureApiError(err, 'POST /api/projects/[id]/push')
    const msg = err instanceof Error ? err.message : 'Push failed'
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
