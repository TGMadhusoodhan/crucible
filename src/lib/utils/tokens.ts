import type { Message } from '@/types'

const CHARS_PER_TOKEN = 4  // 1 token ≈ 4 chars — standard rough approximation

// ─── Estimation ───────────────────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function estimateTokensFromMessages(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0)
  // +4 per message accounts for role/metadata overhead
}

// ─── Truncation ───────────────────────────────────────────────────────────────

/**
 * Truncates text to fit within a token budget.
 * Cuts at the last word boundary before the limit so the result isn't mid-word.
 */
export function truncateToTokenLimit(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut) + '\n[...truncated]'
}

/**
 * Trims a history array to fit within a token budget (from the oldest end).
 * Always keeps the most recent messages.
 */
export function trimHistoryToTokenLimit(messages: Message[], maxTokens: number): Message[] {
  const trimmed: Message[] = []
  let tokens = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateTokens(messages[i]!.content) + 4
    if (tokens + t > maxTokens) break
    trimmed.unshift(messages[i]!)
    tokens += t
  }

  return trimmed
}

// ─── Budget helpers ───────────────────────────────────────────────────────────

/** Estimates USD cost given token counts and per-million-token pricing. */
export function estimateCost(
  tokensIn: number,
  tokensOut: number,
  inputPricePerMillion: number,
  outputPricePerMillion: number,
): number {
  return (tokensIn / 1_000_000) * inputPricePerMillion +
         (tokensOut / 1_000_000) * outputPricePerMillion
}
