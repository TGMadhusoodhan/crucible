import { auth } from '@clerk/nextjs/server'
import { Redis } from '@upstash/redis'
import { NextResponse } from 'next/server'
import type { ApiResponse } from '@/types'

function getRedis() {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  })
}

// GET /api/projects/:id — get project details
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    const project = await getRedis().get(`project:${userId}:${id}`)
    if (!project) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

    return NextResponse.json({ success: true, data: project })
  } catch (err) {
    console.error('GET /api/projects/[id]:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE /api/projects/:id — delete a project
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    const redis = getRedis()

    const existing = await redis.get(`project:${userId}:${id}`)
    if (!existing) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

    await Promise.all([
      redis.del(`project:${userId}:${id}`),
      redis.srem(`projects:${userId}`, id),
    ])

    return NextResponse.json({ success: true, data: null })
  } catch (err) {
    console.error('DELETE /api/projects/[id]:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
