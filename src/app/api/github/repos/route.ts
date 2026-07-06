import { eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { db, schema } from '@/lib/db'
import { decrypt } from '@/lib/crypto'
import { createGitHubRepo } from '@/lib/workspace/github'
import { captureApiError } from '@/lib/sentry'
import type { ApiResponse } from '@/types'

const postSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[\w.-]+$/, 'Repo name must be alphanumeric (hyphens/dots ok)'),
})

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const parsed = postSchema.safeParse(await request.json() as unknown)
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 })
    }

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

    const fullName = await createGitHubRepo(parsed.data.name, token)
    return NextResponse.json({ success: true, data: { fullName } }, { status: 201 })
  } catch (err) {
    captureApiError(err, 'POST /api/github/repos')
    const msg = err instanceof Error ? err.message : 'Failed to create repo'
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
