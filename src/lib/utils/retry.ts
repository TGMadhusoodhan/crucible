// Retry and timeout utilities for all model API calls.
// Architecture rules:
//   - 3 retries maximum
//   - Backoff: 1s → 2s → 4s
//   - Timeout: 120s for generate(), 60s for all other calls

export const TIMEOUT_GENERATE_MS = 300_000  // 5 min
export const TIMEOUT_THINK_MS   = 480_000  // 8 min — DeepSeek V4 Pro is very slow on complex prompts
export const TIMEOUT_REVIEW_MS  = 300_000  // 5 min — reviewer reads full generated code
export const TIMEOUT_DEFAULT_MS = 120_000  // 2 min — alignment chat, self-check

// ─── Timeout wrapper ──────────────────────────────────────────────────────────

export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${ms}ms${label ? ` (${label})` : ''}`))
    }, ms)

    promise.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err as Error) },
    )
  })
}

// ─── Retry with exponential backoff ──────────────────────────────────────────

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      // Don't retry on auth errors (401) or not-found (404) — they won't self-heal
      const msg = lastError.message
      if (msg.includes('HTTP 401') || msg.includes('HTTP 404')) throw lastError
      if (attempt < maxAttempts - 1) {
        await sleep(baseDelayMs * Math.pow(2, attempt))  // 1s, 2s, 4s
      }
    }
  }
  throw lastError
}

// ─── Combined retry + timeout ─────────────────────────────────────────────────

export async function retryWithTimeout<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number
    baseDelayMs?: number
    timeoutMs?: number
    label?: string
  } = {},
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 1000, timeoutMs = TIMEOUT_DEFAULT_MS, label } = opts
  return retryWithBackoff(
    () => withTimeout(fn(), timeoutMs, label),
    maxAttempts,
    baseDelayMs,
  )
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
