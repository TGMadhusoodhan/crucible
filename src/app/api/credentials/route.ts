import { auth, currentUser } from '@clerk/nextjs/server'
import { eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { db, schema } from '@/lib/db'
import { encrypt } from '@/lib/crypto'
import type { ApiResponse, Provider } from '@/types'

const PROVIDERS = ['anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together'] as const

const postSchema = z.object({
  provider: z.enum(PROVIDERS),
  apiKey: z.string().min(1, 'API key is required'),
})

// Validates a key with the lightest possible call to each provider
async function validateApiKey(provider: Provider, apiKey: string): Promise<{ valid: boolean; networkError?: string }> {
  const configs: Record<Provider, { url: string; headers: Record<string, string> }> = {
    anthropic: {
      url: 'https://api.anthropic.com/v1/models',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    },
    openai: {
      url: 'https://api.openai.com/v1/models',
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    deepseek: {
      url: 'https://api.deepseek.com/v1/models',
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    google: {
      url: `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`,
      headers: {},
    },
    mistral: {
      url: 'https://api.mistral.ai/v1/models',
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    openrouter: {
      url: 'https://openrouter.ai/api/v1/models',
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    groq: {
      url: 'https://api.groq.com/openai/v1/models',
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    together: {
      url: 'https://api.together.xyz/v1/models',
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  }

  const { url, headers } = configs[provider]
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    return { valid: res.ok }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const isTimeout = msg.toLowerCase().includes('timeout') || msg.includes('TimeoutError')
    return {
      valid: false,
      networkError: isTimeout
        ? `${provider} API timed out. The key may be valid — try again.`
        : `Could not reach ${provider}. Check your network connection.`,
    }
  }
}

// Creates user row if not yet synced by webhook (webhook deferred to post-deploy)
async function getOrCreateDbUser(clerkUserId: string) {
  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.clerkUserId, clerkUserId))
    .limit(1)

  if (existing[0]) return existing[0]

  const clerkUser = await currentUser()
  if (!clerkUser) throw new Error('Could not fetch Clerk user')

  const email = clerkUser.emailAddresses[0]?.emailAddress
  if (!email) throw new Error('Clerk user has no email address')

  const [created] = await db
    .insert(schema.users)
    .values({ email, clerkUserId })
    .onConflictDoUpdate({
      target: schema.users.clerkUserId,
      set: { email },
    })
    .returning()

  return created!
}

// GET /api/credentials — list connected providers (never returns the key itself)
export async function GET(): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId: clerkUserId } = await auth()
    if (!clerkUserId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const user = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.clerkUserId, clerkUserId))
      .limit(1)

    if (!user[0]) {
      return NextResponse.json({ success: true, data: [] })
    }

    const credentials = await db
      .select({
        id: schema.apiCredentials.id,
        provider: schema.apiCredentials.provider,
        isValid: schema.apiCredentials.isValid,
        createdAt: schema.apiCredentials.createdAt,
      })
      .from(schema.apiCredentials)
      .where(eq(schema.apiCredentials.userId, user[0].id))

    return NextResponse.json({ success: true, data: credentials })
  } catch (err) {
    console.error('GET /api/credentials:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

// POST /api/credentials — validate key against provider, encrypt, then store
export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId: clerkUserId } = await auth()
    if (!clerkUserId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json() as unknown
    const parsed = postSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      )
    }

    const { provider, apiKey } = parsed.data

    const { valid: isValid, networkError } = await validateApiKey(provider, apiKey)
    if (!isValid) {
      return NextResponse.json(
        {
          success: false,
          error: networkError ?? `API key rejected by ${provider}. Check the key and try again.`,
        },
        { status: networkError ? 502 : 422 },
      )
    }

    const user = await getOrCreateDbUser(clerkUserId)
    const encryptedKey = encrypt(apiKey)

    const [credential] = await db
      .insert(schema.apiCredentials)
      .values({ userId: user.id, provider, encryptedKey, isValid: true })
      .onConflictDoUpdate({
        target: [schema.apiCredentials.userId, schema.apiCredentials.provider],
        set: { encryptedKey, isValid: true },
      })
      .returning({
        id: schema.apiCredentials.id,
        provider: schema.apiCredentials.provider,
        isValid: schema.apiCredentials.isValid,
        createdAt: schema.apiCredentials.createdAt,
      })

    return NextResponse.json({ success: true, data: credential })
  } catch (err) {
    console.error('POST /api/credentials:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
