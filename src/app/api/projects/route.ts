import { auth } from '@clerk/nextjs/server'
import { Redis } from '@upstash/redis'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { generateId } from '@/lib/utils'
import type { ApiResponse, Provider } from '@/types'

interface ProjectData {
  id: string
  userId: string
  name: string
  description: string
  primaryProvider: Provider
  primaryModelId: string
  reviewerProvider: Provider
  reviewerModelId: string
  createdAt: number
}

function getRedis() {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  })
}

const PROVIDERS = ['anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together'] as const

const createSchema = z.object({
  name:             z.string().min(1).max(100),
  description:      z.string().max(500).default(''),
  primaryProvider:  z.enum(PROVIDERS),
  primaryModelId:   z.string().min(1),
  reviewerProvider: z.enum(PROVIDERS),
  reviewerModelId:  z.string().min(1),
})

// GET /api/projects — list all projects for current user
export async function GET(): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const redis = getRedis()
    const ids = await redis.smembers<string[]>(`projects:${userId}`)
    if (!ids.length) return NextResponse.json({ success: true, data: [] })

    const projects = await Promise.all(
      ids.map((id) => redis.get<ProjectData>(`project:${userId}:${id}`)),
    )

    return NextResponse.json({
      success: true,
      data: projects.filter(Boolean).sort((a, b) => b!.createdAt - a!.createdAt),
    })
  } catch (err) {
    console.error('GET /api/projects:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

// POST /api/projects — create new project
export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const parsed = createSchema.safeParse(await request.json() as unknown)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      )
    }

    const project: ProjectData = {
      id:        generateId(),
      userId,
      createdAt: Date.now(),
      ...parsed.data,
    }

    const redis = getRedis()
    await redis.set(`project:${userId}:${project.id}`, project, { ex: 60 * 60 * 24 * 365 })
    await redis.sadd(`projects:${userId}`, project.id)

    return NextResponse.json({ success: true, data: project }, { status: 201 })
  } catch (err) {
    console.error('POST /api/projects:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
