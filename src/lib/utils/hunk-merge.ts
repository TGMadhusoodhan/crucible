import type { HunkConflict, HunkMergeResult, ResolvedHunk, ReviewHunk } from '@/types'

// ─── Anchor location ──────────────────────────────────────────────────────────
// Locate original_code in the file. Returns the 1-based line range where it was
// found, or null if not found. Tries: (1) exact match, (2) whitespace-normalized
// match nearest to lineHint, (3) null.

export function locateInFile(
  code:         string,
  originalCode: string,
  lineHint:     number,
): { lineStart: number; lineEnd: number } | null {
  const fileLines   = code.split('\n')
  const anchorLines = originalCode.split('\n')
  const n = anchorLines.length

  // Exact match
  const exactMatches: number[] = []
  outer: for (let i = 0; i <= fileLines.length - n; i++) {
    for (let k = 0; k < n; k++) {
      if (fileLines[i + k] !== anchorLines[k]) continue outer
    }
    exactMatches.push(i)
  }
  if (exactMatches.length > 0) {
    const best = exactMatches.reduce((a, b) =>
      Math.abs(a - (lineHint - 1)) <= Math.abs(b - (lineHint - 1)) ? a : b
    )
    return { lineStart: best + 1, lineEnd: best + n }
  }

  // Whitespace-normalized match (trailing spaces stripped, blank lines preserved)
  const normalAnchor = anchorLines.map(l => l.trimEnd())
  const normalMatches: number[] = []
  outer2: for (let i = 0; i <= fileLines.length - n; i++) {
    for (let k = 0; k < n; k++) {
      if (fileLines[i + k]!.trimEnd() !== normalAnchor[k]) continue outer2
    }
    normalMatches.push(i)
  }
  if (normalMatches.length > 0) {
    const best = normalMatches.reduce((a, b) =>
      Math.abs(a - (lineHint - 1)) <= Math.abs(b - (lineHint - 1)) ? a : b
    )
    return { lineStart: best + 1, lineEnd: best + n }
  }

  return null
}

// ─── Merge ────────────────────────────────────────────────────────────────────

export function mergeReviewHunks(
  r1Hunks:      ReviewHunk[],
  r2Hunks:      ReviewHunk[],
  originalCode: Record<string, string>,  // filename → original DeepSeek code
): HunkMergeResult {
  const resolved:  ResolvedHunk[]  = []
  const conflicts: HunkConflict[]  = []

  const r1ByFile = groupByFile(r1Hunks)
  const r2ByFile = groupByFile(r2Hunks)
  const allFiles = new Set([...r1ByFile.keys(), ...r2ByFile.keys()])

  for (const filename of allFiles) {
    const r1   = r1ByFile.get(filename) ?? []
    const r2   = r2ByFile.get(filename) ?? []
    const orig = originalCode[filename] ?? ''

    // Resolve located positions for each hunk — use anchor when available,
    // fall back to raw line hints otherwise.
    const locatedR1 = r1.map(h => locate(h, orig))
    const locatedR2 = r2.map(h => locate(h, orig))

    for (const group of groupOverlapping(locatedR1, locatedR2)) {
      const lineStart = Math.min(...group.all.map(h => h.line_start))
      const lineEnd   = Math.max(...group.all.map(h => h.line_end))

      if (group.r1.length > 0 && group.r2.length > 0) {
        const r1Hunk = collapseGroup(group.r1, 'R1', lineStart, lineEnd)
        const r2Hunk = collapseGroup(group.r2, 'R2', lineStart, lineEnd)
        conflicts.push({
          id:            `conflict_${r1Hunk.id}_${r2Hunk.id}`,
          filename,
          line_start:    lineStart,
          line_end:      lineEnd,
          r1_hunk:       r1Hunk,
          r2_hunk:       r2Hunk,
          original_code: extractLines(orig, lineStart, lineEnd),
        })
      } else if (group.r1.length > 0) {
        resolved.push(toResolvedFromGroup(group.r1, 'R1', lineStart, lineEnd))
      } else {
        resolved.push(toResolvedFromGroup(group.r2, 'R2', lineStart, lineEnd))
      }
    }
  }

  return { resolved, conflicts }
}

// ─── Apply ────────────────────────────────────────────────────────────────────
// Anchor-based string replacement. For each hunk:
//   1. If original_code present → locate it in the file → replace (deterministic).
//   2. If original_code absent → fall back to line-number-based splicing.
// Hunks that can't be located are returned in failedHunks.

export function applyResolvedHunks(
  code:  string,
  hunks: ResolvedHunk[],
): { code: string; failedHunks: ResolvedHunk[] } {
  const failedHunks: ResolvedHunk[] = []

  // Separate hunks into anchor-based and line-based
  const anchorHunks: Array<{ hunk: ResolvedHunk; lineStart: number; lineEnd: number }> = []
  const lineHunks:   ResolvedHunk[] = []

  for (const hunk of hunks) {
    if (hunk.original_code?.trim()) {
      const loc = locateInFile(code, hunk.original_code, hunk.line_start)
      if (loc) {
        anchorHunks.push({ hunk, lineStart: loc.lineStart, lineEnd: loc.lineEnd })
      } else {
        console.warn(`[applyResolvedHunks] anchor not found for hunk ${JSON.stringify(hunk.flag_ids)} — moving to failed`)
        failedHunks.push(hunk)
      }
    } else {
      // No anchor — fall back to line-based
      lineHunks.push(hunk)
    }
  }

  // Apply anchor hunks bottom-to-top (by located position, not hint)
  const sortedAnchor = anchorHunks.sort((a, b) => b.lineStart - a.lineStart)
  const lines = code.split('\n')
  for (const { hunk, lineStart, lineEnd } of sortedAnchor) {
    const start    = Math.max(0, lineStart - 1)
    const end      = Math.min(lines.length, lineEnd)
    const newLines = hunk.new_code.split('\n')
    lines.splice(start, end - start, ...newLines)
  }
  let result = lines.join('\n')

  // Apply line-based hunks bottom-to-top (fallback for hunks without original_code)
  if (lineHunks.length > 0) {
    const sortedLine = [...lineHunks].sort((a, b) => b.line_start - a.line_start)
    const fallbackLines = result.split('\n')
    for (const hunk of sortedLine) {
      const start    = Math.max(0, hunk.line_start - 1)
      const end      = Math.min(fallbackLines.length, hunk.line_end)
      const newLines = hunk.new_code.split('\n')
      fallbackLines.splice(start, end - start, ...newLines)
    }
    result = fallbackLines.join('\n')
  }

  return { code: result, failedHunks }
}

// ─── Internals ────────────────────────────────────────────────────────────────

// Returns the hunk with positions resolved via anchor (when available)
// so that groupOverlapping uses accurate file positions for conflict detection.
function locate(hunk: ReviewHunk, fileContent: string): ReviewHunk {
  if (!hunk.original_code?.trim()) return hunk
  const loc = locateInFile(fileContent, hunk.original_code, hunk.line_start)
  if (!loc) return hunk
  return { ...hunk, line_start: loc.lineStart, line_end: loc.lineEnd }
}

function rangesOverlap(
  a: { line_start: number; line_end: number },
  b: { line_start: number; line_end: number },
): boolean {
  return a.line_start <= b.line_end && b.line_start <= a.line_end
}

function groupByFile(hunks: ReviewHunk[]): Map<string, ReviewHunk[]> {
  const map = new Map<string, ReviewHunk[]>()
  for (const h of hunks) {
    if (!map.has(h.filename)) map.set(h.filename, [])
    map.get(h.filename)!.push(h)
  }
  return map
}

// Groups hunks from both reviewers into connected components by transitive
// range overlap — if h1 overlaps h2 and h2 overlaps h3, all three land in the
// same group even though h1/h3 may not directly overlap. Without this, one
// hunk overlapping two hunks on the other side would produce two separate
// conflicts that themselves overlap each other, which applyResolvedHunks
// cannot splice safely (it only guards against drift between hunks that
// don't overlap, not against genuinely overlapping ranges).
function groupOverlapping(
  r1: ReviewHunk[],
  r2: ReviewHunk[],
): Array<{ r1: ReviewHunk[]; r2: ReviewHunk[]; all: ReviewHunk[] }> {
  const all = [...r1, ...r2]
  const parent = all.map((_, i) => i)

  function find(i: number): number {
    if (parent[i] !== i) parent[i] = find(parent[i]!)
    return parent[i]!
  }
  function union(i: number, j: number): void {
    const a = find(i), b = find(j)
    if (a !== b) parent[a] = b
  }

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (rangesOverlap(all[i]!, all[j]!)) union(i, j)
    }
  }

  const groups = new Map<number, { r1: ReviewHunk[]; r2: ReviewHunk[]; all: ReviewHunk[] }>()
  all.forEach((h, i) => {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, { r1: [], r2: [], all: [] })
    const g = groups.get(root)!
    g.all.push(h)
    if (i < r1.length) g.r1.push(h)
    else g.r2.push(h)
  })
  return [...groups.values()]
}

const SEVERITY_RANK = { HIGH: 2, MEDIUM: 1, LOW: 0 } as const

// Collapses multiple overlapping hunks from the SAME reviewer into one
// representative ReviewHunk spanning the merged range. The highest-severity
// hunk's fix wins; its original_code is kept if it's the only one (a merged
// multi-hunk span rarely has a single clean anchor).
function collapseGroup(hunks: ReviewHunk[], source: 'R1' | 'R2', lineStart: number, lineEnd: number): ReviewHunk {
  const winner = hunks.length === 1
    ? hunks[0]!
    : hunks.reduce((best, h) => (SEVERITY_RANK[h.severity] > SEVERITY_RANK[best.severity] ? h : best))
  return {
    ...winner,
    id:            hunks.map(h => h.id).join('+'),
    line_start:    lineStart,
    line_end:      lineEnd,
    issue:         hunks.map(h => h.issue).join(' | '),
    // original_code: keep only when a single hunk collapsed (unambiguous anchor)
    original_code: hunks.length === 1 ? winner.original_code : undefined,
    source,
  }
}

function toResolvedFromGroup(hunks: ReviewHunk[], source: 'R1' | 'R2', lineStart: number, lineEnd: number): ResolvedHunk {
  const winner = hunks.length === 1
    ? hunks[0]!
    : hunks.reduce((best, h) => (SEVERITY_RANK[h.severity] > SEVERITY_RANK[best.severity] ? h : best))
  return {
    filename:      winner.filename,
    line_start:    lineStart,
    line_end:      lineEnd,
    original_code: hunks.length === 1 ? winner.original_code : undefined,
    new_code:      winner.fixed_code,
    source,
    flag_ids:      hunks.map(h => h.id),
  }
}

function extractLines(code: string, start: number, end: number): string {
  return code.split('\n').slice(start - 1, end).join('\n')
}
