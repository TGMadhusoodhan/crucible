
// ─── Override formatting ──────────────────────────────────────────────────────

// Architecture rule: the model MUST explicitly acknowledge before continuing.
// This prevents the "noted, however..." failure mode where the model
// acknowledges in one word and then ignores the override.
const ACK_REQUIREMENT =
  '\nAll prior reasoning is subordinate to this directive.\n' +
  'Acknowledge explicitly — say "Acknowledged:" followed by your confirmation — before continuing.'

/**
 * Wraps a human message in the HUMAN OVERRIDE envelope that tells both models
 * this message has top priority over all prior context.
 */
export function formatHumanOverride(message: string): string {
  return `HUMAN OVERRIDE: ${message}${ACK_REQUIREMENT}`
}

// ─── ACK detection ────────────────────────────────────────────────────────────

// Patterns that count as genuine acknowledgement (not just "noted, however...")
const ACK_PATTERNS = [
  /\backnowledged\b/i,
  /\bi acknowledge\b/i,
  /\bunderstood\b/i,
  /\bi understand\b/i,
  /\bconfirmed\b/i,
  /\bi confirm\b/i,
  /\bwill do\b/i,
  /\baffirmed\b/i,
]

/**
 * Returns true if the model response contains an explicit acknowledgement
 * of the human override. A bare "noted" does not qualify.
 */
export function hasAcknowledgedOverride(modelResponse: string): boolean {
  return ACK_PATTERNS.some(pattern => pattern.test(modelResponse))
}

/**
 * Returns true if the model tried to soften/dismiss the override with phrases
 * like "Noted, however..." — these require escalation.
 */
export function hasDismissedOverride(modelResponse: string): boolean {
  const lower = modelResponse.toLowerCase()
  const dismissal = ['noted, however', 'noted. however', 'understood, but', 'understood but',
                     'acknowledged, however', 'yes but', 'i see, however']
  return dismissal.some(d => lower.includes(d))
}

/**
 * Drains all pending human overrides from the session state's list and
 * returns a single combined override string, or null if none are pending.
 */
export function consumePendingOverrides(overrides: string[]): string | null {
  if (overrides.length === 0) return null
  const combined = overrides
    .map((msg, i) => `Override ${i + 1}: ${msg}`)
    .join('\n\n')
  return formatHumanOverride(combined)
}
