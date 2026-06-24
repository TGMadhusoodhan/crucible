import { eq, and } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { MODEL_PRICING } from '@/lib/adapters/base'
import { estimateTokens } from '@/lib/utils/tokens'
import type { BudgetMode, BudgetStatus, Provider, ProviderBudget } from '@/types'

const DEFAULT_MONTHLY_BUDGET_USD = 50

const ALL_PROVIDERS: Provider[] = [
  'anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together',
]

function currentYearMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function daysElapsed(): number { return new Date().getDate() }
function daysInCurrentMonth(): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
}

function toMode(percentRemaining: number, hasCap: boolean): BudgetMode {
  if (!hasCap) return 'FULL'
  if (percentRemaining > 75) return 'FULL'
  if (percentRemaining > 50) return 'EFFICIENT'
  if (percentRemaining > 25) return 'CONSERVATION'
  return 'CRITICAL'
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function recordUsage(
  _userId:      string,   // kept for API compatibility — single user, not used
  sessionId:    string,
  provider:     Provider,
  modelId:      string,
  inputTokens:  number,
  outputTokens: number,
): Promise<void> {
  const pricing = MODEL_PRICING[modelId]
  if (!pricing) return

  const costUsd  = (inputTokens  / 1_000_000) * pricing.input +
                   (outputTokens / 1_000_000) * pricing.output
  const totalTok = inputTokens + outputTokens
  const ym       = currentYearMonth()

  // Upsert provider monthly spend
  const existing = db
    .select()
    .from(schema.budgetSpend)
    .where(and(
      eq(schema.budgetSpend.provider,  provider),
      eq(schema.budgetSpend.yearMonth, ym),
    ))
    .get()

  if (existing) {
    db.update(schema.budgetSpend)
      .set({ spendUsd: existing.spendUsd + costUsd })
      .where(and(
        eq(schema.budgetSpend.provider,  provider),
        eq(schema.budgetSpend.yearMonth, ym),
      ))
      .run()
  } else {
    db.insert(schema.budgetSpend)
      .values({ provider, yearMonth: ym, spendUsd: costUsd })
      .run()
  }

  // Upsert session cost
  const existingSession = db
    .select()
    .from(schema.sessionCosts)
    .where(eq(schema.sessionCosts.sessionId, sessionId))
    .get()

  if (existingSession) {
    db.update(schema.sessionCosts)
      .set({
        costUsd: existingSession.costUsd + costUsd,
        tokens:  existingSession.tokens  + totalTok,
      })
      .where(eq(schema.sessionCosts.sessionId, sessionId))
      .run()
  } else {
    db.insert(schema.sessionCosts)
      .values({ sessionId, costUsd, tokens: totalTok })
      .run()
  }
}

export async function recordUsageFromText(
  userId:    string,
  sessionId: string,
  provider:  Provider,
  modelId:   string,
  inputText: string,
  outputText:string,
): Promise<void> {
  return recordUsage(
    userId, sessionId, provider, modelId,
    estimateTokens(inputText),
    estimateTokens(outputText),
  )
}

export async function setProviderCap(
  _userId:  string,
  provider: Provider,
  capUsd:   number,
): Promise<void> {
  if (capUsd <= 0) {
    db.delete(schema.providerCaps)
      .where(eq(schema.providerCaps.provider, provider))
      .run()
  } else {
    const existing = db
      .select()
      .from(schema.providerCaps)
      .where(eq(schema.providerCaps.provider, provider))
      .get()
    if (existing) {
      db.update(schema.providerCaps)
        .set({ capUsd })
        .where(eq(schema.providerCaps.provider, provider))
        .run()
    } else {
      db.insert(schema.providerCaps).values({ provider, capUsd }).run()
    }
  }
}

export async function getBudgetStatus(
  _userId:    string,
  sessionId?: string,
): Promise<BudgetStatus> {
  const ym  = currentYearMonth()

  const caps   = db.select().from(schema.providerCaps).all()
  const spends = db.select().from(schema.budgetSpend)
    .where(eq(schema.budgetSpend.yearMonth, ym))
    .all()

  const capMap   = new Map(caps.map(c => [c.provider, c.capUsd]))
  const spendMap = new Map(spends.map(s => [s.provider, s.spendUsd]))

  const providerBreakdown: ProviderBudget[] = []
  let totalCapUsd   = 0
  let totalSpentUsd = 0

  for (const provider of ALL_PROVIDERS) {
    const cap   = capMap.get(provider) ?? 0
    const spent = spendMap.get(provider) ?? 0
    totalSpentUsd += spent
    if (cap > 0) totalCapUsd += cap

    if (cap > 0 || spent > 0) {
      const remaining   = cap > 0 ? Math.max(0, cap - spent) : 0
      const percentUsed = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0
      providerBreakdown.push({ provider: provider as Provider, capUsd: cap, spentUsd: spent, remainingUsd: remaining, percentUsed })
    }
  }

  const hasCap            = totalCapUsd > 0
  const totalRemainingUsd = hasCap ? Math.max(0, totalCapUsd - totalSpentUsd) : 0
  const percentRemaining  = hasCap ? (totalRemainingUsd / totalCapUsd) * 100 : 100

  const elapsed              = daysElapsed()
  const dailyAverageUsd      = elapsed > 0 ? totalSpentUsd / elapsed : 0
  const projectedMonthEndUsd = dailyAverageUsd * daysInCurrentMonth()

  let sessionCostUsd = 0
  let sessionTokens  = 0
  if (sessionId) {
    const s = db.select().from(schema.sessionCosts)
      .where(eq(schema.sessionCosts.sessionId, sessionId))
      .get()
    sessionCostUsd = s?.costUsd ?? 0
    sessionTokens  = s?.tokens  ?? 0
  }

  return {
    mode: toMode(percentRemaining, hasCap),
    providerBreakdown,
    totalCapUsd,
    totalSpentUsd,
    totalRemainingUsd,
    percentRemaining,
    daysElapsed:        elapsed,
    dailyAverageUsd,
    projectedMonthEndUsd,
    sessionTokens,
    sessionCostUsd,
    monthlyBudgetUsd:   hasCap ? totalCapUsd : DEFAULT_MONTHLY_BUDGET_USD,
    spentUsd:           totalSpentUsd,
    remainingUsd:       totalRemainingUsd,
  }
}

export async function getBudgetMode(_userId: string): Promise<BudgetMode> {
  const status = await getBudgetStatus(_userId)
  return status.mode
}

/** @deprecated kept for API compatibility */
export async function setMonthlyBudget(_userId: string, _budgetUsd: number): Promise<void> {
  // No-op: per-provider caps replaced the global budget
}
