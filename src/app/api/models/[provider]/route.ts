import { auth } from '@clerk/nextjs/server'
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { decrypt } from '@/lib/crypto'
import type { ApiResponse, Provider } from '@/types'

const MODEL_ENDPOINTS: Record<Provider, { url: string; authHeader: (key: string) => Record<string, string> }> = {
  deepseek:   { url: 'https://api.deepseek.com/v1/models',                       authHeader: (k) => ({ Authorization: `Bearer ${k}` }) },
  openai:     { url: 'https://api.openai.com/v1/models',                         authHeader: (k) => ({ Authorization: `Bearer ${k}` }) },
  anthropic:  { url: 'https://api.anthropic.com/v1/models',                      authHeader: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
  google:     { url: 'https://generativelanguage.googleapis.com/v1/models',       authHeader: (k) => ({}) },   // key in query string
  mistral:    { url: 'https://api.mistral.ai/v1/models',                          authHeader: (k) => ({ Authorization: `Bearer ${k}` }) },
  openrouter: { url: 'https://openrouter.ai/api/v1/models',                      authHeader: (k) => ({ Authorization: `Bearer ${k}` }) },
  groq:       { url: 'https://api.groq.com/openai/v1/models',                    authHeader: (k) => ({ Authorization: `Bearer ${k}` }) },
  together:   { url: 'https://api.together.xyz/v1/models',                       authHeader: (k) => ({ Authorization: `Bearer ${k}` }) },
}

// GET /api/models/:provider — fetch real model list from provider using stored key
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId: clerkUserId } = await auth()
    if (!clerkUserId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const { provider } = await params

    if (!(provider in MODEL_ENDPOINTS)) {
      return NextResponse.json({ success: false, error: `Unknown provider: ${provider}` }, { status: 400 })
    }

    const user = await db.select().from(schema.users).where(eq(schema.users.clerkUserId, clerkUserId)).limit(1)
    if (!user[0]) return NextResponse.json({ success: false, error: 'Connect an API key first' }, { status: 404 })

    const cred = await db.select().from(schema.apiCredentials)
      .where(eq(schema.apiCredentials.userId, user[0].id))
      .then((rows) => rows.find((r) => r.provider === provider))

    if (!cred) {
      return NextResponse.json({ success: false, error: `No API key saved for ${provider}` }, { status: 404 })
    }

    const apiKey   = decrypt(cred.encryptedKey)
    const endpoint = MODEL_ENDPOINTS[provider as Provider]!
    const url      = provider === 'google' ? `${endpoint.url}?key=${apiKey}` : endpoint.url

    const res = await fetch(url, {
      headers:    endpoint.authHeader(apiKey),
      signal:     AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const body = await res.text()
      return NextResponse.json(
        { success: false, error: `${provider} returned HTTP ${res.status}: ${body.slice(0, 200)}` },
        { status: 502 },
      )
    }

    const raw = await res.json() as Record<string, unknown>

    // Normalise: different providers return different shapes
    let modelIds: string[] = []
    if (Array.isArray(raw.data)) {
      modelIds = (raw.data as Array<{ id?: string }>).map((m) => m.id ?? '').filter(Boolean)
    } else if (Array.isArray(raw.models)) {
      modelIds = (raw.models as Array<{ name?: string; id?: string }>)
        .map((m) => m.name ?? m.id ?? '').filter(Boolean)
    }

    return NextResponse.json({ success: true, data: modelIds.sort() })
  } catch (err) {
    console.error('GET /api/models/[provider]:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
