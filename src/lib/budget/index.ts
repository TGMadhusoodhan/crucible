import { Redis } from '@upstash/redis'
import { MODEL_PRICING } from '@/lib/adapters/base'
import { estimateTokens } from '@/lib/memory/filesystem'
import type { BudgetMode, BudgetStatus, Provider, ProviderBudget } from '@/types'

const DEFAULT_MONTHLY_BUDGET_USD = 50
const SESSION_KEY_TTL = 60 * 60 * 24 * 7   // 7 days
const SPEND_KEY_TTL  = 60 * 60 * 24 * 35   // 35 days (full month + buffer)

// ─── Redis keys ───────────────────────────────────────────────────────────────

function globalSpendKey(userId: string, yearMonth: string) {
  return `budget:${userId}:spend:${yearMonth}`
}
function providerSpendKey(userId: string, provider: string, yearMonth: string) {
  return `budget:${userId}:provider:${provider}:spend:${yearMonth}`
}
function providerCapKey(userId: string, provider: string) {
  return `budget:${userId}:provider:${provider}:cap`
}
function sessionCostKey(userId: string, sessionId: string) {
  return `budget:${userId}:session:${sessionId}:cost_usd`
}
function sessionTokenKey(userId: string, sessionId: string) {
  return `budget:${userId}:session:${sessionId}:tokens`
}
// legacy key — read-only, replaced by per-provider caps
function legacyMonthlyBudgetKey(userId: string) {
  return `budget:${userId}:monthly_budget`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const _redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})
function getRedis(): Redis { return _redis }

function currentYearMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function daysElapsed(): number {
  return new Date().getDate()
}

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

// All known providers — used to fan-out Redis reads in getBudgetStatus
const ALL_PROVIDERS: Provider[] = [
  'anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together',
]

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Records token usage for a pipeline step, tracked globally AND per-provider.
 */
export async function recordUsage(
  userId: string,
  sessionId: string,
  provider: Provider,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const pricing = MODEL_PRICING[modelId]
  if (!pricing) return

  const costUsd   = (inputTokens  / 1_000_000) * pricing.input +
                    (outputTokens / 1_000_000) * pricing.output
  const totalTok  = inputTokens + outputTokens
  const redis     = getRedis()
  const ym        = currentYearMonth()

  // Batch all 8 Redis commands into a single pipeline request
  const pipe = redis.pipeline()
  pipe.incrbyfloat(globalSpendKey(userId, ym), costUsd)
  pipe.expire(globalSpendKey(userId, ym), SPEND_KEY_TTL)
  pipe.incrbyfloat(providerSpendKey(userId, provider, ym), costUsd)
  pipe.expire(providerSpendKey(userId, provider, ym), SPEND_KEY_TTL)
  pipe.incrbyfloat(sessionCostKey(userId, sessionId), costUsd)
  pipe.expire(sessionCostKey(userId, sessionId), SESSION_KEY_TTL)
  pipe.incrby(sessionTokenKey(userId, sessionId), totalTok)
  pipe.expire(sessionTokenKey(userId, sessionId), SESSION_KEY_TTL)
  await pipe.exec()
}

/**
 * Convenience wrapper: estimates tokens from text and records usage.
 */
export async function recordUsageFromText(
  userId: string,
  sessionId: string,
  provider: Provider,
  modelId: string,
  inputText: string,
  outputText: string,
): Promise<void> {
  const inputTokens  = estimateTokens(inputText)
  const outputTokens = estimateTokens(outputText)
  return recordUsage(userId, sessionId, provider, modelId, inputTokens, outputTokens)
}

/**
 * Sets the spending cap for a specific provider (USD/month).
 * Pass 0 to remove the cap.
 */
export async function setProviderCap(
  userId: string,
  provider: Provider,
  capUsd: number,
): Promise<void> {
  const redis = getRedis()
  if (capUsd <= 0) {
    await redis.del(providerCapKey(userId, provider))
  } else {
    await redis.set(providerCapKey(userId, provider), capUsd)
  }
}

/**
 * Returns the full budget status including per-provider breakdown.
 */
export async function getBudgetStatus(
  userId: string,
  sessionId?: string,
): Promise<BudgetStatus> {
  const redis = getRedis()
  const ym    = currentYearMonth()

  // Fan-out: read caps and spends for all providers in parallel
  const capKeys   = ALL_PROVIDERS.map((p) => providerCapKey(userId, p))
  const spendKeys = ALL_PROVIDERS.map((p) => providerSpendKey(userId, p, ym))

  const [
    capsRaw,
    spendsRaw,
    sessionCostRaw,
    sessionTokensRaw,
  ] = await Promise.all([
    redis.mget<(number | null)[]>(...capKeys),
    redis.mget<(number | null)[]>(...spendKeys),
    sessionId ? redis.get<number>(sessionCostKey(userId, sessionId)) : Promise.resolve(null),
    sessionId ? redis.get<number>(sessionTokenKey(userId, sessionId)) : Promise.resolve(null),
  ])

  // Build per-provider breakdown (only include providers with cap or spend)
  const providerBreakdown: ProviderBudget[] = []
  let totalCapUsd   = 0
  let totalSpentUsd = 0

  ALL_PROVIDERS.forEach((provider, i) => {
    const cap   = Number(capsRaw[i]   ?? 0)
    const spent = Number(spendsRaw[i] ?? 0)

    totalSpentUsd += spent
    if (cap > 0) totalCapUsd += cap

    if (cap > 0 || spent > 0) {
      const remaining  = cap > 0 ? Math.max(0, cap - spent) : Infinity
      const percentUsed = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0
      providerBreakdown.push({ provider, capUsd: cap, spentUsd: spent, remainingUsd: remaining === Infinity ? 0 : remaining, percentUsed })
    }
  })

  const hasCap           = totalCapUsd > 0
  const totalRemainingUsd = hasCap ? Math.max(0, totalCapUsd - totalSpentUsd) : 0
  const percentRemaining  = hasCap
    ? (totalRemainingUsd / totalCapUsd) * 100
    : 100

  const elapsed              = daysElapsed()
  const dailyAverageUsd      = elapsed > 0 ? totalSpentUsd / elapsed : 0
  const projectedMonthEndUsd = dailyAverageUsd * daysInCurrentMonth()

  const sessionCostUsd = Number(sessionCostRaw   ?? 0)
  const sessionTokens  = Number(sessionTokensRaw ?? 0)

  return {
    mode:               toMode(percentRemaining, hasCap),
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
    // legacy aliases
    monthlyBudgetUsd:   hasCap ? totalCapUsd : DEFAULT_MONTHLY_BUDGET_USD,
    spentUsd:           totalSpentUsd,
    remainingUsd:       totalRemainingUsd,
  }
}

/**
 * Returns just the current operating mode — cheap check for pipeline gates.
 */
export async function getBudgetMode(userId: string): Promise<BudgetMode> {
  const status = await getBudgetStatus(userId)
  return status.mode
}

/**
 * Legacy: sets a single global monthly budget. Kept for any existing calls.
 * @deprecated Use setProviderCap per provider instead.
 */
export async function setMonthlyBudget(userId: string, budgetUsd: number): Promise<void> {
  await getRedis().set(legacyMonthlyBudgetKey(userId), budgetUsd)
}
