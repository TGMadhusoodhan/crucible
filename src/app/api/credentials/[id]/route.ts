import { auth } from '@clerk/nextjs/server'
import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import type { ApiResponse } from '@/types'

// DELETE /api/credentials/:id — remove a provider key
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId: clerkUserId } = await auth()
    if (!clerkUserId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params

    const user = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.clerkUserId, clerkUserId))
      .limit(1)

    if (!user[0]) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }

    const deleted = await db
      .delete(schema.apiCredentials)
      .where(
        and(
          eq(schema.apiCredentials.id, id),
          eq(schema.apiCredentials.userId, user[0].id),
        ),
      )
      .returning({ id: schema.apiCredentials.id })

    if (!deleted[0]) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('DELETE /api/credentials/[id]:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
