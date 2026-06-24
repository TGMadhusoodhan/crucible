import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getBudgetStatus, setMonthlyBudget, setProviderCap } from '@/lib/budget'
import type { ApiResponse, Provider } from '@/types'

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const userId = 'local'
    const sessionId = new URL(request.url).searchParams.get('sessionId') ?? undefined
    const status = await getBudgetStatus(userId, sessionId)
    return NextResponse.json({ success: true, data: status })
  } catch (err) {
    console.error('GET /api/budget:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

const providerCapSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together']),
  capUsd:   z.number().min(0),
})

const globalBudgetSchema = z.object({
  monthlyBudgetUsd: z.number().positive(),
})

export async function PATCH(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const userId = 'local'
    const body = await request.json() as unknown

    const providerParsed = providerCapSchema.safeParse(body)
    if (providerParsed.success) {
      await setProviderCap(userId, providerParsed.data.provider as Provider, providerParsed.data.capUsd)
      return NextResponse.json({ success: true })
    }

    const globalParsed = globalBudgetSchema.safeParse(body)
    if (globalParsed.success) {
      await setMonthlyBudget(userId, globalParsed.data.monthlyBudgetUsd)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json(
      { success: false, error: 'Provide { provider, capUsd } or { monthlyBudgetUsd }' },
      { status: 400 },
    )
  } catch (err) {
    console.error('PATCH /api/budget:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
