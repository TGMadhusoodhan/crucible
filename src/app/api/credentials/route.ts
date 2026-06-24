import { eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { db, schema } from '@/lib/db'
import { encrypt } from '@/lib/crypto'
import { generateId } from '@/lib/utils'
import { captureApiError } from '@/lib/sentry'
import type { ApiResponse, Provider } from '@/types'

const PROVIDERS = ['anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together'] as const

const postSchema = z.object({
  provider: z.enum(PROVIDERS),
  apiKey:   z.string().min(1, 'API key is required'),
})

async function validateApiKey(provider: Provider, apiKey: string): Promise<{ valid: boolean; networkError?: string }> {
  const configs: Record<Provider, { url: string; headers: Record<string, string> }> = {
    anthropic:  { url: 'https://api.anthropic.com/v1/models',                      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
    openai:     { url: 'https://api.openai.com/v1/models',                         headers: { Authorization: `Bearer ${apiKey}` } },
    deepseek:   { url: 'https://api.deepseek.com/v1/models',                       headers: { Authorization: `Bearer ${apiKey}` } },
    google:     { url: `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`, headers: {} },
    mistral:    { url: 'https://api.mistral.ai/v1/models',                         headers: { Authorization: `Bearer ${apiKey}` } },
    openrouter: { url: 'https://openrouter.ai/api/v1/models',                      headers: { Authorization: `Bearer ${apiKey}` } },
    groq:       { url: 'https://api.groq.com/openai/v1/models',                    headers: { Authorization: `Bearer ${apiKey}` } },
    together:   { url: 'https://api.together.xyz/v1/models',                       headers: { Authorization: `Bearer ${apiKey}` } },
  }
  const { url, headers } = configs[provider]
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
    return { valid: res.ok }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const isTimeout = msg.toLowerCase().includes('timeout') || msg.includes('TimeoutError')
    return {
      valid: false,
      networkError: isTimeout
        ? `${provider} API timed out. The key may be valid — try again.`
        : `Could not reach ${provider}. Check your network.`,
    }
  }
}

export async function GET(): Promise<NextResponse<ApiResponse>> {
  try {
    const credentials = await db
      .select({ id: schema.apiCredentials.id, provider: schema.apiCredentials.provider, isValid: schema.apiCredentials.isValid, createdAt: schema.apiCredentials.createdAt })
      .from(schema.apiCredentials)
    return NextResponse.json({ success: true, data: credentials })
  } catch (err) {
    captureApiError(err, 'GET /api/credentials')
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const body   = await request.json() as unknown
    const parsed = postSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 })
    }
    const { provider, apiKey } = parsed.data

    const { valid, networkError } = await validateApiKey(provider as Provider, apiKey)
    if (!valid) {
      return NextResponse.json(
        { success: false, error: networkError ?? `API key rejected by ${provider}.` },
        { status: networkError ? 502 : 422 },
      )
    }

    const encryptedKey = encrypt(apiKey)
    const [credential] = await db
      .insert(schema.apiCredentials)
      .values({ id: generateId(), provider, encryptedKey, isValid: true, createdAt: Date.now() })
      .onConflictDoUpdate({ target: schema.apiCredentials.provider, set: { encryptedKey, isValid: true } })
      .returning({ id: schema.apiCredentials.id, provider: schema.apiCredentials.provider, isValid: schema.apiCredentials.isValid, createdAt: schema.apiCredentials.createdAt })

    return NextResponse.json({ success: true, data: credential })
  } catch (err) {
    captureApiError(err, 'POST /api/credentials')
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
