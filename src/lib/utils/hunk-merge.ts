import type { HunkConflict, HunkMergeResult, ResolvedHunk, ReviewHunk } from '@/types'

export function mergeReviewHunks(
  r1Hunks: ReviewHunk[],
  r2Hunks: ReviewHunk[],
  originalCode: Record<string, string>,  // filename → original DeepSeek code
): HunkMergeResult {
  const resolved:  ResolvedHunk[]  = []
  const conflicts: HunkConflict[]  = []

  // Group by filename
  const r1ByFile = groupByFile(r1Hunks)
  const r2ByFile = groupByFile(r2Hunks)

  const allFiles = new Set([...r1ByFile.keys(), ...r2ByFile.keys()])

  for (const filename of allFiles) {
    const r1 = r1ByFile.get(filename) ?? []
    const r2 = r2ByFile.get(filename) ?? []
    const orig = originalCode[filename] ?? ''

    for (const group of groupOverlapping(r1, r2)) {
      const lineStart = Math.min(...group.all.map(h => h.line_start))
      const lineEnd   = Math.max(...group.all.map(h => h.line_end))

      if (group.r1.length > 0 && group.r2.length > 0) {
        // Both reviewers touched this span — exactly one conflict for the
        // whole group (even if one side overlaps multiple hunks from the
        // other), so no two emitted units can ever overlap once resolved.
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

export function applyResolvedHunks(
  code:   string,
  hunks:  ResolvedHunk[],
): string {
  // Sort bottom-to-top to prevent line number drift
  const sorted = [...hunks].sort((a, b) => b.line_start - a.line_start)
  const lines  = code.split('\n')
  for (const hunk of sorted) {
    const start    = Math.max(0, hunk.line_start - 1)
    const end      = Math.min(lines.length, hunk.line_end)
    const newLines = hunk.new_code.split('\n')
    lines.splice(start, end - start, ...newLines)
  }
  return lines.join('\n')
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

// Collapses multiple overlapping hunks from the SAME reviewer (rare — a
// reviewer normally shouldn't emit overlapping hunks for one file) into one
// representative ReviewHunk spanning the merged range, keeping the
// highest-severity hunk's fix as the winner.
function collapseGroup(hunks: ReviewHunk[], source: 'R1' | 'R2', lineStart: number, lineEnd: number): ReviewHunk {
  const winner = hunks.length === 1
    ? hunks[0]!
    : hunks.reduce((best, h) => (SEVERITY_RANK[h.severity] > SEVERITY_RANK[best.severity] ? h : best))
  return {
    ...winner,
    id:         hunks.map(h => h.id).join('+'),
    line_start: lineStart,
    line_end:   lineEnd,
    issue:      hunks.map(h => h.issue).join(' | '),
    source,
  }
}

function toResolvedFromGroup(hunks: ReviewHunk[], source: 'R1' | 'R2', lineStart: number, lineEnd: number): ResolvedHunk {
  const winner = hunks.length === 1
    ? hunks[0]!
    : hunks.reduce((best, h) => (SEVERITY_RANK[h.severity] > SEVERITY_RANK[best.severity] ? h : best))
  return {
    filename:   winner.filename,
    line_start: lineStart,
    line_end:   lineEnd,
    new_code:   winner.fixed_code,
    source,
    flag_ids:   hunks.map(h => h.id),
  }
}

function extractLines(code: string, start: number, end: number): string {
  return code.split('\n').slice(start - 1, end).join('\n')
}
