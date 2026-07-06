import { eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { db, schema } from '@/lib/db'
import { decrypt } from '@/lib/crypto'
import { createSession } from '@/lib/pipeline/orchestrator'
import { captureApiError } from '@/lib/sentry'
import type { ApiResponse, Provider } from '@/types'

const PROVIDERS = ['anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together'] as const

const startSchema = z.object({
  projectId:       z.string().min(1),
  taskDescription: z.string().min(1).max(50_000),
  r1Provider:      z.enum(PROVIDERS),
  r1ModelId:       z.string().min(1).max(200),
  r2Provider:      z.enum(PROVIDERS),
  r2ModelId:       z.string().min(1).max(200),
  contextText:     z.string().max(40_000).optional(),
  contextFiles:    z.array(z.string().max(500)).max(50).optional(),
})

const CODER_PROVIDER  = 'deepseek' as const
const CODER_MODEL_ID  = 'deepseek-v4-pro' as const

async function getApiKey(provider: Provider): Promise<string | null> {
  const [row] = await db
    .select({ encryptedKey: schema.apiCredentials.encryptedKey, isValid: schema.apiCredentials.isValid })
    .from(schema.apiCredentials)
    .where(eq(schema.apiCredentials.provider, provider))
    .limit(1)
  if (!row || !row.isValid) return null
  try { return decrypt(row.encryptedKey) } catch { return null }
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const userId = 'local'

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
      r1Provider, r1ModelId,
      r2Provider, r2ModelId,
      contextText, contextFiles,
    } = parsed.data

    if (r1Provider === r2Provider) {
      return NextResponse.json(
        {
          success: false,
          error: `R1 and R2 must use different providers for genuine cross-validation. Both are set to "${r1Provider}".`,
        },
        { status: 422 },
      )
    }

    const [coderApiKey, r1ApiKey, r2ApiKey] = await Promise.all([
      getApiKey(CODER_PROVIDER),
      getApiKey(r1Provider),
      getApiKey(r2Provider),
    ])

    if (!coderApiKey) {
      return NextResponse.json(
        { success: false, error: `No valid API key for ${CODER_PROVIDER} (coder model). Add it in Settings.` },
        { status: 422 },
      )
    }

    if (!r1ApiKey) {
      return NextResponse.json(
        { success: false, error: `No valid API key for ${r1Provider} (R1 model). Add it in Settings.` },
        { status: 422 },
      )
    }

    if (!r2ApiKey) {
      return NextResponse.json(
        { success: false, error: `No valid API key for ${r2Provider} (R2 model). Add it in Settings.` },
        { status: 422 },
      )
    }

    const sessionId = await createSession({
      userId,
      projectId,
      taskDescription,
      config: {
        coderProvider: CODER_PROVIDER,
        coderModelId:  CODER_MODEL_ID,
        coderApiKey,
        r1Provider, r1ModelId, r1ApiKey,
        r2Provider, r2ModelId, r2ApiKey,
      },
      contextInput: (contextText || contextFiles?.length)
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
