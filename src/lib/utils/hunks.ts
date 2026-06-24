import type { ReviewHunk } from '@/types'

/**
 * Applies a list of reviewer hunks to the given code string.
 * Each hunk matches on `original` and replaces with `replacement`.
 * If `original` is not found verbatim, tries a trimmed line-level match.
 * Hunks whose `original` cannot be located are silently skipped — the
 * reviewer may have referenced a non-existent snippet.
 */
export function applyHunks(code: string, hunks: ReviewHunk[]): string {
  let result = code

  for (const hunk of hunks) {
    if (!hunk.original?.trim() || hunk.replacement === undefined) continue

    // Fast path: exact substring match
    if (result.includes(hunk.original)) {
      result = result.replace(hunk.original, hunk.replacement)
      continue
    }

    // Slow path: try matching after normalizing internal whitespace.
    // Handles cases where the model output has slightly different line endings.
    const normalizeWs = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '')
    const normalizedCode     = normalizeWs(result)
    const normalizedOriginal = normalizeWs(hunk.original)

    if (normalizedCode.includes(normalizedOriginal)) {
      result = normalizeWs(result).replace(normalizedOriginal, hunk.replacement)
      continue
    }

    // Line-level match: find lines in `result` that match the trimmed original
    const lines     = result.split('\n')
    const origLines = hunk.original.trim().split('\n')
    if (origLines.length === 1) {
      const trimmedTarget = origLines[0]!.trim()
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]?.trim() === trimmedTarget) {
          const indent = lines[i]!.match(/^(\s*)/)?.[1] ?? ''
          lines[i] = indent + hunk.replacement.trim()
          result = lines.join('\n')
          break
        }
      }
    }
    // If still not matched, skip — never corrupt the code with a bad hunk
  }

  return result
}
