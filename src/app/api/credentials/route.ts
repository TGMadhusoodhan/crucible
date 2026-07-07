import { eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { db, schema } from '@/lib/db'
import { encrypt } from '@/lib/crypto'
import { generateId } from '@/lib/utils'
import { captureApiError } from '@/lib/sentry'
import { fetchGitHubUser } from '@/lib/workspace/github'
import type { ApiResponse, Provider } from '@/types'

// AI inference providers + 'github' (credential-only, not a pipeline adapter)
type CredentialProvider = Provider | 'github'

const PROVIDERS = ['anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together', 'zai', 'github'] as const

const postSchema = z.object({
  provider: z.enum(PROVIDERS),
  apiKey:   z.string().min(1, 'API key is required'),
})

type ValidateResult = { valid: boolean; networkError?: string; metadata?: string }

async function validateApiKey(provider: CredentialProvider, apiKey: string): Promise<ValidateResult> {
  // GitHub PAT: validate via /user endpoint and capture login
  if (provider === 'github') {
    try {
      const user = await fetchGitHubUser(apiKey)
      return { valid: true, metadata: JSON.stringify({ login: user.login }) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isTimeout = msg.toLowerCase().includes('timeout') || msg.includes('TimeoutError')
      return {
        valid: false,
        networkError: isTimeout
          ? 'GitHub API timed out. The token may be valid — try again.'
          : `GitHub token rejected: ${msg.slice(0, 200)}`,
      }
    }
  }

  const configs: Record<Provider, { url: string; headers: Record<string, string> }> = {
    anthropic:  { url: 'https://api.anthropic.com/v1/models',                      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
    openai:     { url: 'https://api.openai.com/v1/models',                         headers: { Authorization: `Bearer ${apiKey}` } },
    deepseek:   { url: 'https://api.deepseek.com/v1/models',                       headers: { Authorization: `Bearer ${apiKey}` } },
    google:     { url: `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`, headers: {} },
    mistral:    { url: 'https://api.mistral.ai/v1/models',                         headers: { Authorization: `Bearer ${apiKey}` } },
    openrouter: { url: 'https://openrouter.ai/api/v1/models',                      headers: { Authorization: `Bearer ${apiKey}` } },
    groq:       { url: 'https://api.groq.com/openai/v1/models',                    headers: { Authorization: `Bearer ${apiKey}` } },
    together:   { url: 'https://api.together.xyz/v1/models',                       headers: { Authorization: `Bearer ${apiKey}` } },
    zai:          { url: 'https://api.z.ai/api/paas/v4/models',                    headers: { Authorization: `Bearer ${apiKey}` } },
    'claude-code': { url: '', headers: {} },  // no API key — CLI subscription
    codex:         { url: '', headers: {} },  // no API key — CLI subscription
  }
  const { url, headers } = configs[provider as Provider]
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
    const rows = await db
      .select({
        id:       schema.apiCredentials.id,
        provider: schema.apiCredentials.provider,
        isValid:  schema.apiCredentials.isValid,
        metadata: schema.apiCredentials.metadata,
        createdAt:schema.apiCredentials.createdAt,
      })
      .from(schema.apiCredentials)
    // Parse metadata and expose safe fields (e.g. login) without leaking keys
    const credentials = rows.map(r => {
      let extra: Record<string, string> = {}
      if (r.metadata) {
        try { extra = JSON.parse(r.metadata) as Record<string, string> } catch { /* ignore */ }
      }
      return { id: r.id, provider: r.provider, isValid: r.isValid, createdAt: r.createdAt, ...extra }
    })
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

    const { valid, networkError, metadata } = await validateApiKey(provider as CredentialProvider, apiKey)
    if (!valid) {
      return NextResponse.json(
        { success: false, error: networkError ?? `API key rejected by ${provider}.` },
        { status: networkError ? 502 : 422 },
      )
    }

    const encryptedKey = encrypt(apiKey)
    const [credential] = await db
      .insert(schema.apiCredentials)
      .values({ id: generateId(), provider, encryptedKey, isValid: true, metadata: metadata ?? null, createdAt: Date.now() })
      .onConflictDoUpdate({ target: schema.apiCredentials.provider, set: { encryptedKey, isValid: true, metadata: metadata ?? null } })
      .returning({ id: schema.apiCredentials.id, provider: schema.apiCredentials.provider, isValid: schema.apiCredentials.isValid, metadata: schema.apiCredentials.metadata, createdAt: schema.apiCredentials.createdAt })

    // Expose safe metadata fields alongside credential
    let extra: Record<string, string> = {}
    if (credential?.metadata) {
      try { extra = JSON.parse(credential.metadata) as Record<string, string> } catch { /* ignore */ }
    }
    return NextResponse.json({ success: true, data: { ...credential, ...extra } })
  } catch (err) {
    captureApiError(err, 'POST /api/credentials')
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
