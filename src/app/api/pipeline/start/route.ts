import { auth } from '@clerk/nextjs/server'
import { eq, and } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { db, schema } from '@/lib/db'
import { decrypt } from '@/lib/crypto'
import { createSession } from '@/lib/pipeline/orchestrator'
import { captureApiError } from '@/lib/sentry'
import type { ApiResponse, Provider } from '@/types'

const PROVIDERS = ['anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together'] as const

const startSchema = z.object({
  projectId:        z.string().uuid(),
  taskDescription:  z.string().min(1).max(10_000),
  primaryProvider:  z.enum(PROVIDERS),
  primaryModelId:   z.string().min(1).max(200),
  reviewerProvider: z.enum(PROVIDERS),
  reviewerModelId:  z.string().min(1).max(200),
  contextText:      z.string().max(40_000).optional(),
  contextFiles:     z.array(z.string().max(500)).max(50).optional(),
})

// Fetch + decrypt an API key from DB for a given provider.
// Returns null if the user has not connected this provider.
async function getApiKey(dbUserId: string, provider: Provider): Promise<string | null> {
  const rows = await db
    .select({ encryptedKey: schema.apiCredentials.encryptedKey, isValid: schema.apiCredentials.isValid })
    .from(schema.apiCredentials)
    .where(
      and(
        eq(schema.apiCredentials.userId, dbUserId),
        eq(schema.apiCredentials.provider, provider),
      ),
    )
    .limit(1)

  const row = rows[0]
  if (!row || !row.isValid) return null

  try {
    return decrypt(row.encryptedKey)
  } catch {
    // Decryption failure — key is corrupted or ENCRYPTION_KEY changed
    return null
  }
}

// POST /api/pipeline/start
// Creates a new pipeline session and returns sessionId.
// The client then connects to GET /api/pipeline/stream to run the pipeline.
export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId: clerkUserId } = await auth()
    if (!clerkUserId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json() as unknown
    const parsed = startSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      )
    }

    const {
      projectId, taskDescription,
      primaryProvider, primaryModelId,
      reviewerProvider, reviewerModelId,
      contextText, contextFiles,
    } = parsed.data

    // Crucible's core value: cross-model validation from different training families.
    // Same provider = same training data = same blind spots = no genuine cross-check.
    if (primaryProvider === reviewerProvider) {
      return NextResponse.json(
        {
          success: false,
          error: `Primary and reviewer must use different providers for genuine cross-validation. Both are set to "${primaryProvider}".`,
        },
        { status: 422 },
      )
    }

    // Get DB user record
    const userRows = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.clerkUserId, clerkUserId))
      .limit(1)

    if (!userRows[0]) {
      return NextResponse.json({ success: false, error: 'User not found — add an API key first' }, { status: 404 })
    }

    const dbUserId = userRows[0].id

    // Fetch and decrypt API keys
    const [primaryApiKey, reviewerApiKey] = await Promise.all([
      getApiKey(dbUserId, primaryProvider),
      getApiKey(dbUserId, reviewerProvider),
    ])

    if (!primaryApiKey) {
      return NextResponse.json(
        { success: false, error: `No valid API key for ${primaryProvider} (primary model). Add it in Settings.` },
        { status: 422 },
      )
    }

    if (!reviewerApiKey) {
      return NextResponse.json(
        { success: false, error: `No valid API key for ${reviewerProvider} (reviewer model). Add it in Settings.` },
        { status: 422 },
      )
    }

    const sessionId = await createSession({
      userId:          clerkUserId,
      projectId,
      taskDescription,
      config: {
        primaryProvider,
        primaryModelId,
        primaryApiKey,
        reviewerProvider,
        reviewerModelId,
        reviewerApiKey,
      },
      contextInput: contextText || (contextFiles?.length)
        ? { text: contextText, files: contextFiles }
        : undefined,
    })

    return NextResponse.json({ success: true, data: { sessionId } }, { status: 201 })
  } catch (err) {
    console.error('POST /api/pipeline/start:', err instanceof Error ? err.message : err)
    captureApiError(err, 'POST /api/pipeline/start')
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(): Promise<NextResponse<ApiResponse>> {
  return NextResponse.json({ success: false, error: 'Use POST to start a pipeline session' }, { status: 405 })
}
