import { truncateToTokenLimit } from '@/lib/utils/tokens'
import type { ContextInput } from '@/types'

// Codebase context is injected into every prompt that follows.
// Keep it under 10k tokens so it doesn't dominate model budgets.
const CONTEXT_MAX_TOKENS = 10_000

export interface Phase0Result {
  contextText: string
}

/**
 * Normalizes and truncates codebase context supplied by the user.
 * File contents are expected already concatenated into `input.text` by the
 * client (via File System Access API). The file paths list is surfaced in the
 * context header so models know which files were included.
 */
export function runPhase0Context(input: ContextInput): Phase0Result {
  const parts: string[] = []

  if (input.files && input.files.length > 0) {
    parts.push(`Files included: ${input.files.join(', ')}`)
  }

  if (input.text?.trim()) {
    parts.push(input.text.trim())
  }

  if (parts.length === 0) {
    return { contextText: '' }
  }

  const contextText = truncateToTokenLimit(parts.join('\n\n'), CONTEXT_MAX_TOKENS)
  return { contextText }
}
