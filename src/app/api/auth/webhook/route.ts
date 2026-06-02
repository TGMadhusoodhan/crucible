import { createHmac, timingSafeEqual } from 'crypto'
import { headers } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { db, schema } from '@/lib/db'
import type { ApiResponse } from '@/types'

interface ClerkUserEvent {
  type: string
  data: {
    id: string
    email_addresses: Array<{ email_address: string; id: string }>
    primary_email_address_id: string
  }
}

// Svix webhook signature verification (no external library needed).
// Algorithm: HMAC-SHA256 over "${svix-id}.${svix-timestamp}.${body}",
// with the secret base64-decoded. Compare against svix-signature header.
function verifySvixSignature(
  body:      string,
  secret:    string,  // base64-encoded secret (without "whsec_" prefix)
  svixId:    string,
  svixTs:    string,
  svixSig:   string,  // "v1,<base64sig1> v1,<base64sig2>"
): boolean {
  const toSign = `${svixId}.${svixTs}.${body}`

  let keyBytes: Buffer
  try {
    keyBytes = Buffer.from(secret, 'base64')
  } catch {
    return false
  }

  const expected = createHmac('sha256', keyBytes)
    .update(toSign)
    .digest('base64')

  // svix-signature may contain multiple space-separated "v1,<sig>" entries
  const sigs = svixSig.split(' ').map(s => s.replace(/^v1,/, ''))
  return sigs.some(sig => {
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(sig, 'base64'))
    } catch {
      return false
    }
  })
}

// POST /api/auth/webhook
// Clerk webhook: creates or deletes the user row in Neon on Clerk events.
// Configure in Clerk Dashboard → Webhooks → user.created, user.deleted.
// Requires CLERK_WEBHOOK_SECRET env var (the "Signing Secret" from Clerk Dashboard,
// with the "whsec_" prefix stripped — just the base64 portion).
export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  const rawSecret = process.env.CLERK_WEBHOOK_SECRET ?? ''
  // Strip the "whsec_" prefix if present
  const secret = rawSecret.startsWith('whsec_') ? rawSecret.slice(6) : rawSecret

  if (!secret) {
    console.error('[webhook] CLERK_WEBHOOK_SECRET is not set')
    return NextResponse.json({ success: false, error: 'Webhook secret not configured' }, { status: 500 })
  }

  const headersList = await headers()
  const svixId        = headersList.get('svix-id')
  const svixTimestamp = headersList.get('svix-timestamp')
  const svixSignature = headersList.get('svix-signature')

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ success: false, error: 'Missing Svix headers' }, { status: 400 })
  }

  const body = await request.text()

  const valid = verifySvixSignature(body, secret, svixId, svixTimestamp, svixSignature)
  if (!valid) {
    console.error('[webhook] Svix signature verification failed')
    return NextResponse.json({ success: false, error: 'Invalid webhook signature' }, { status: 401 })
  }

  let event: ClerkUserEvent
  try {
    event = JSON.parse(body) as ClerkUserEvent
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    if (event.type === 'user.created') {
      const primary = event.data.email_addresses.find(
        e => e.id === event.data.primary_email_address_id,
      )
      const email = primary?.email_address
      if (!email) {
        console.error('[webhook] user.created has no primary email for', event.data.id)
        return NextResponse.json({ success: false, error: 'No primary email' }, { status: 422 })
      }

      await db
        .insert(schema.users)
        .values({ email, clerkUserId: event.data.id })
        .onConflictDoUpdate({
          target: schema.users.clerkUserId,
          set: { email },
        })
    }

    if (event.type === 'user.deleted') {
      const { eq } = await import('drizzle-orm')
      await db
        .delete(schema.users)
        .where(eq(schema.users.clerkUserId, event.data.id))
    }

    return NextResponse.json({ success: true, data: { type: event.type } })
  } catch (err) {
    console.error('[webhook] DB operation failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Database error' }, { status: 500 })
  }
}
