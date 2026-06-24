import { desc } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { db, schema } from '@/lib/db'
import { generateId } from '@/lib/utils'
import type { ApiResponse } from '@/types'

const PROVIDERS = ['anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together'] as const

const createSchema = z.object({
  name:             z.string().min(1).max(100),
  description:      z.string().max(500).default(''),
  primaryProvider:  z.enum(PROVIDERS),
  primaryModelId:   z.string().min(1),
  reviewerProvider: z.enum(PROVIDERS),
  reviewerModelId:  z.string().min(1),
})

export async function GET(): Promise<NextResponse<ApiResponse>> {
  try {
    const projects = await db
      .select()
      .from(schema.projects)
      .orderBy(desc(schema.projects.createdAt))
    return NextResponse.json({ success: true, data: projects })
  } catch (err) {
    console.error('GET /api/projects:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const parsed = createSchema.safeParse(await request.json() as unknown)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      )
    }

    const [project] = await db
      .insert(schema.projects)
      .values({ id: generateId(), createdAt: Date.now(), ...parsed.data })
      .returning()

    return NextResponse.json({ success: true, data: project }, { status: 201 })
  } catch (err) {
    console.error('POST /api/projects:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
