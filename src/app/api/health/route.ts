import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'

// GET /api/health — Docker HEALTHCHECK endpoint
export async function GET(): Promise<NextResponse> {
  try {
    db.run(sql`SELECT 1`)
    return NextResponse.json({ status: 'ok', timestamp: Date.now() })
  } catch {
    return NextResponse.json({ status: 'error' }, { status: 503 })
  }
}
