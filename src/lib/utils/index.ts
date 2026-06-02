import type { BudgetStatus, Provider, ProviderBudget } from '@/types'

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ')
}

/**
 * Returns a new BudgetStatus with a single provider cap changed.
 * Used for optimistic UI updates — call this before the network request
 * so the budget bar reflects the change instantly.
 */
export function applyCapToBudget(
  budget: BudgetStatus,
  provider: Provider,
  capUsd: number,
): BudgetStatus {
  const existing = budget.providerBreakdown.find((b) => b.provider === provider)

  let newBreakdown: ProviderBudget[]
  if (capUsd === 0) {
    // Keep row if it has spend so it's still visible; otherwise drop it
    newBreakdown = budget.providerBreakdown
      .map((b) => b.provider === provider ? { ...b, capUsd: 0, remainingUsd: 0, percentUsed: 0 } : b)
      .filter((b) => b.capUsd > 0 || b.spentUsd > 0)
  } else if (existing) {
    newBreakdown = budget.providerBreakdown.map((b) =>
      b.provider === provider
        ? {
            ...b,
            capUsd,
            remainingUsd: Math.max(0, capUsd - b.spentUsd),
            percentUsed:  Math.min(100, b.spentUsd > 0 ? (b.spentUsd / capUsd) * 100 : 0),
          }
        : b,
    )
  } else {
    newBreakdown = [
      ...budget.providerBreakdown,
      { provider, capUsd, spentUsd: 0, remainingUsd: capUsd, percentUsed: 0 },
    ]
  }

  const totalCapUsd       = newBreakdown.reduce((s, b) => s + b.capUsd, 0)
  const totalSpentUsd     = budget.totalSpentUsd
  const totalRemainingUsd = Math.max(0, totalCapUsd - totalSpentUsd)
  const percentRemaining  = totalCapUsd > 0 ? (totalRemainingUsd / totalCapUsd) * 100 : 100

  const mode = totalCapUsd === 0 ? 'FULL'
    : percentRemaining > 75 ? 'FULL'
    : percentRemaining > 50 ? 'EFFICIENT'
    : percentRemaining > 25 ? 'CONSERVATION'
    : 'CRITICAL'

  return {
    ...budget,
    providerBreakdown: newBreakdown,
    totalCapUsd,
    totalRemainingUsd,
    percentRemaining,
    mode,
    // legacy aliases
    monthlyBudgetUsd: totalCapUsd,
    remainingUsd:     totalRemainingUsd,
  }
}

export function generateId(): string {
  return crypto.randomUUID()
}

// Re-export from dedicated files — use these directly in new code
export { sleep, retryWithBackoff, retryWithTimeout, withTimeout } from './retry'
export { estimateTokens, estimateTokensFromMessages, truncateToTokenLimit, trimHistoryToTokenLimit } from './tokens'
