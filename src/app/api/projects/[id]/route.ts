import { eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { db, schema } from '@/lib/db'
import { decrypt } from '@/lib/crypto'
import { checkRepoWriteAccess } from '@/lib/workspace/github'
import type { ApiResponse } from '@/types'

const patchSchema = z.object({
  githubRepo:     z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Must be owner/repo format').optional().nullable(),
  githubPushMode: z.enum(['off', 'per_file', 'per_session']).optional(),
  githubBranch:   z.string().min(1).max(255).optional(),
})

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<ApiResponse>> {
  try {
    const { id } = await params
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1)
    if (!project) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    return NextResponse.json({ success: true, data: project })
  } catch (err) {
    console.error('GET /api/projects/[id]:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<ApiResponse>> {
  try {
    const { id } = await params
    const parsed = patchSchema.safeParse(await request.json() as unknown)
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 })
    }

    const { githubRepo, githubPushMode, githubBranch } = parsed.data

    // If linking a repo, validate write access using stored GitHub token
    if (githubRepo) {
      const [credRow] = await db
        .select({ encryptedKey: schema.apiCredentials.encryptedKey, isValid: schema.apiCredentials.isValid })
        .from(schema.apiCredentials)
        .where(eq(schema.apiCredentials.provider, 'github'))
        .limit(1)
      if (!credRow?.isValid) {
        return NextResponse.json({ success: false, error: 'No valid GitHub token — add one in Settings first' }, { status: 422 })
      }
      let token: string
      try { token = decrypt(credRow.encryptedKey) } catch {
        return NextResponse.json({ success: false, error: 'Failed to decrypt GitHub token' }, { status: 500 })
      }
      const [owner, repo] = githubRepo.split('/')
      try {
        await checkRepoWriteAccess(owner!, repo!, token)
      } catch (err) {
        return NextResponse.json(
          { success: false, error: err instanceof Error ? err.message : 'Repo access check failed' },
          { status: 422 },
        )
      }
    }

    const set: {
      githubRepo?:     string | null
      githubPushMode?: string
      githubBranch?:   string
    } = {}
    if ('githubRepo' in parsed.data) set.githubRepo     = githubRepo ?? null
    if (githubPushMode !== undefined) set.githubPushMode = githubPushMode
    if (githubBranch   !== undefined) set.githubBranch   = githubBranch

    const [updated] = await db
      .update(schema.projects)
      .set(set)
      .where(eq(schema.projects.id, id))
      .returning()
    if (!updated) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    return NextResponse.json({ success: true, data: updated })
  } catch (err) {
    console.error('PATCH /api/projects/[id]:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<ApiResponse>> {
  try {
    const { id } = await params
    const [deleted] = await db
      .delete(schema.projects)
      .where(eq(schema.projects.id, id))
      .returning({ id: schema.projects.id })
    if (!deleted) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    return NextResponse.json({ success: true, data: null })
  } catch (err) {
    console.error('DELETE /api/projects/[id]:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
