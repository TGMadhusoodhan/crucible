#!/usr/bin/env node
// Tests hunk-merge logic deterministically — no API keys, no network calls.
// Run with: node scripts/test-hunk-merge.mjs

let passed = 0
let failed = 0

function assert(cond, msg) {
  if (cond) { console.log('  ✓', msg); passed++ }
  else       { console.error('  ✗ FAIL:', msg); failed++ }
}

// ─── Inline the logic under test (avoids TSX transpile overhead) ─────────────

function locateInFile(code, originalCode, lineHint) {
  const fileLines   = code.split('\n')
  const anchorLines = originalCode.split('\n')
  const n = anchorLines.length

  // Exact match
  const exactMatches = []
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

  // Whitespace-normalized match
  const normalAnchor = anchorLines.map(l => l.trimEnd())
  const normalMatches = []
  outer2: for (let i = 0; i <= fileLines.length - n; i++) {
    for (let k = 0; k < n; k++) {
      if (fileLines[i + k].trimEnd() !== normalAnchor[k]) continue outer2
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

function rangesOverlap(a, b) {
  return a.line_start <= b.line_end && b.line_start <= a.line_end
}

function groupByFile(hunks) {
  const map = new Map()
  for (const h of hunks) {
    if (!map.has(h.filename)) map.set(h.filename, [])
    map.get(h.filename).push(h)
  }
  return map
}

const SEVERITY_RANK = { HIGH: 2, MEDIUM: 1, LOW: 0 }

function locate(hunk, fileContent) {
  if (!hunk.original_code?.trim()) return hunk
  const loc = locateInFile(fileContent, hunk.original_code, hunk.line_start)
  if (!loc) return hunk
  return { ...hunk, line_start: loc.lineStart, line_end: loc.lineEnd }
}

function collapseGroup(hunks, source, lineStart, lineEnd) {
  const winner = hunks.length === 1
    ? hunks[0]
    : hunks.reduce((best, h) => (SEVERITY_RANK[h.severity] > SEVERITY_RANK[best.severity] ? h : best))
  return {
    ...winner,
    id: hunks.map(h => h.id).join('+'),
    line_start: lineStart,
    line_end: lineEnd,
    issue: hunks.map(h => h.issue).join(' | '),
    original_code: hunks.length === 1 ? winner.original_code : undefined,
    source,
  }
}

function toResolvedFromGroup(hunks, source, lineStart, lineEnd) {
  const winner = hunks.length === 1
    ? hunks[0]
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

function groupOverlapping(r1, r2) {
  const all = [...r1, ...r2]
  const parent = all.map((_, i) => i)

  function find(i) {
    if (parent[i] !== i) parent[i] = find(parent[i])
    return parent[i]
  }
  function union(i, j) {
    const a = find(i), b = find(j)
    if (a !== b) parent[a] = b
  }

  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      if (rangesOverlap(all[i], all[j])) union(i, j)

  const groups = new Map()
  all.forEach((h, i) => {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, { r1: [], r2: [], all: [] })
    const g = groups.get(root)
    g.all.push(h)
    if (i < r1.length) g.r1.push(h)
    else g.r2.push(h)
  })
  return [...groups.values()]
}

function mergeReviewHunks(r1Hunks, r2Hunks, originalCode) {
  const resolved  = []
  const conflicts = []
  const r1ByFile  = groupByFile(r1Hunks)
  const r2ByFile  = groupByFile(r2Hunks)
  const allFiles  = new Set([...r1ByFile.keys(), ...r2ByFile.keys()])

  for (const filename of allFiles) {
    const r1   = r1ByFile.get(filename) ?? []
    const r2   = r2ByFile.get(filename) ?? []
    const orig = originalCode[filename] ?? ''

    const locatedR1 = r1.map(h => locate(h, orig))
    const locatedR2 = r2.map(h => locate(h, orig))

    for (const group of groupOverlapping(locatedR1, locatedR2)) {
      const lineStart = Math.min(...group.all.map(h => h.line_start))
      const lineEnd   = Math.max(...group.all.map(h => h.line_end))

      if (group.r1.length > 0 && group.r2.length > 0) {
        const r1Hunk = collapseGroup(group.r1, 'R1', lineStart, lineEnd)
        const r2Hunk = collapseGroup(group.r2, 'R2', lineStart, lineEnd)
        conflicts.push({
          id: `conflict_${r1Hunk.id}_${r2Hunk.id}`,
          filename,
          line_start: lineStart,
          line_end:   lineEnd,
          r1_hunk:    r1Hunk,
          r2_hunk:    r2Hunk,
          original_code: orig.split('\n').slice(lineStart - 1, lineEnd).join('\n'),
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

// Anchor-based apply with line-based fallback for hunks without original_code.
// Returns { code, failedHunks }.
function applyResolvedHunks(code, hunks) {
  const failedHunks = []
  const anchorHunks = []
  const lineHunks   = []

  for (const hunk of hunks) {
    if (hunk.original_code?.trim()) {
      const loc = locateInFile(code, hunk.original_code, hunk.line_start)
      if (loc) {
        anchorHunks.push({ hunk, lineStart: loc.lineStart, lineEnd: loc.lineEnd })
      } else {
        failedHunks.push(hunk)
      }
    } else {
      lineHunks.push(hunk)
    }
  }

  // Apply anchor hunks bottom-to-top by located position
  const sortedAnchor = anchorHunks.sort((a, b) => b.lineStart - a.lineStart)
  const lines = code.split('\n')
  for (const { hunk, lineStart, lineEnd } of sortedAnchor) {
    const start    = Math.max(0, lineStart - 1)
    const end      = Math.min(lines.length, lineEnd)
    const newLines = hunk.new_code.split('\n')
    lines.splice(start, end - start, ...newLines)
  }
  let result = lines.join('\n')

  // Apply line-based hunks bottom-to-top (fallback when no original_code)
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

// ─── Test cases ───────────────────────────────────────────────────────────────

const file = 'math.ts'
const orig = { [file]: 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10' }

// ── Test 1: Non-overlapping hunks → both resolved, no conflicts ──────────────
console.log('\nTest 1: Non-overlapping hunks → both resolved')
{
  const r1 = [{ id: 'h1', filename: file, line_start: 1, line_end: 2, severity: 'HIGH', issue: 'i1', fixed_code: 'R1_FIX_1\nR1_FIX_2', category: 'correctness' }]
  const r2 = [{ id: 'h2', filename: file, line_start: 5, line_end: 6, severity: 'HIGH', issue: 'i2', fixed_code: 'R2_FIX_5\nR2_FIX_6', category: 'correctness' }]
  const result = mergeReviewHunks(r1, r2, orig)
  assert(result.conflicts.length === 0, 'No conflicts (non-overlapping)')
  assert(result.resolved.length === 2, 'Two resolved hunks')
  assert(result.resolved[0].source === 'R1', 'First resolved from R1')
  assert(result.resolved[1].source === 'R2', 'Second resolved from R2')
}

// ── Test 2: Overlapping hunks → one conflict, no resolved ────────────────────
console.log('\nTest 2: Overlapping hunks → one conflict')
{
  const r1 = [{ id: 'h1', filename: file, line_start: 3, line_end: 7, severity: 'HIGH', issue: 'div by zero throw', fixed_code: 'if (b===0) throw', category: 'correctness' }]
  const r2 = [{ id: 'h2', filename: file, line_start: 5, line_end: 9, severity: 'HIGH', issue: 'div by zero return NaN', fixed_code: 'if (b===0) return NaN', category: 'correctness' }]
  const result = mergeReviewHunks(r1, r2, orig)
  assert(result.conflicts.length === 1, 'One conflict')
  assert(result.resolved.length === 0, 'Zero resolved (the overlap is a conflict)')
  assert(result.conflicts[0].line_start === 3, 'Conflict spans minimum line start (3)')
  assert(result.conflicts[0].line_end   === 9, 'Conflict spans maximum line end (9)')
  assert(result.conflicts[0].r1_hunk.source === 'R1', 'Conflict r1_hunk has source R1')
  assert(result.conflicts[0].r2_hunk.source === 'R2', 'Conflict r2_hunk has source R2')
}

// ── Test 3: Transitive overlap (h1 overlaps h2, h2 overlaps h3) → one conflict
console.log('\nTest 3: Transitive overlap → single merged conflict group')
{
  const r1 = [
    { id: 'h1', filename: file, line_start: 1, line_end: 3, severity: 'HIGH', issue: 'i1', fixed_code: 'R1a', category: 'correctness' },
    { id: 'h3', filename: file, line_start: 5, line_end: 7, severity: 'MEDIUM', issue: 'i3', fixed_code: 'R1b', category: 'correctness' },
  ]
  const r2 = [
    { id: 'h2', filename: file, line_start: 3, line_end: 6, severity: 'HIGH', issue: 'i2', fixed_code: 'R2a', category: 'correctness' },
  ]
  const result = mergeReviewHunks(r1, r2, orig)
  // h1(1-3) overlaps h2(3-6); h3(5-7) overlaps h2(3-6) → all three in one group
  assert(result.conflicts.length === 1, 'Transitive overlap → single conflict group')
  assert(result.resolved.length === 0, 'No separated resolved hunks')
  assert(result.conflicts[0].line_start === 1, 'Group spans from line 1')
  assert(result.conflicts[0].line_end   === 7, 'Group spans to line 7')
  // R1 had two hunks collapsed — higher severity (HIGH=h1) wins the representative
  assert(result.conflicts[0].r1_hunk.fixed_code === 'R1a', 'R1 HIGH-severity hunk wins collapse')
}

// ── Test 4: R1 only → resolved, source=R1 ────────────────────────────────────
console.log('\nTest 4: R1-only hunk → resolved as R1')
{
  const r1 = [{ id: 'h1', filename: file, line_start: 2, line_end: 4, severity: 'LOW', issue: 'i1', fixed_code: 'R1_ONLY', category: 'correctness' }]
  const result = mergeReviewHunks(r1, [], orig)
  assert(result.conflicts.length === 0, 'No conflicts when only R1 has hunks')
  assert(result.resolved[0].source === 'R1', 'Resolved from R1')
  assert(result.resolved[0].new_code === 'R1_ONLY', 'Correct fix code')
}

// ── Test 5: applyResolvedHunks — line-based fallback (no original_code) ───────
console.log('\nTest 5: applyResolvedHunks line-based fallback applies bottom-to-top correctly')
{
  const code  = 'a\nb\nc\nd\ne'
  const hunks = [
    { filename: file, line_start: 4, line_end: 5, new_code: 'D\nE', source: 'R1', flag_ids: [] },
    { filename: file, line_start: 1, line_end: 2, new_code: 'A\nB', source: 'R2', flag_ids: [] },
  ]
  const { code: result, failedHunks } = applyResolvedHunks(code, hunks)
  assert(result === 'A\nB\nc\nD\nE', `Result is "A\\nB\\nc\\nD\\nE" (got: ${JSON.stringify(result)})`)
  assert(failedHunks.length === 0, 'No failed hunks')
}

// ── Test 6: applyResolvedHunks line-based with changed line count ─────────────
console.log('\nTest 6: applyResolvedHunks line-based handles different line counts')
{
  const code  = 'a\nb\nc\nd\ne'
  const hunks = [
    { filename: file, line_start: 2, line_end: 3, new_code: 'X\nY\nZ', source: 'R1', flag_ids: [] },
  ]
  const { code: result, failedHunks } = applyResolvedHunks(code, hunks)
  assert(result === 'a\nX\nY\nZ\nd\ne', `Got: ${JSON.stringify(result)}`)
  assert(failedHunks.length === 0, 'No failed hunks')
}

// ── Test 7: Conflict on different files → separate conflicts ──────────────────
console.log('\nTest 7: Multi-file — conflicts stay per-file')
{
  const r1 = [
    { id: 'h1', filename: 'a.ts', line_start: 1, line_end: 2, severity: 'HIGH', issue: 'i1', fixed_code: 'fix1', category: 'correctness' },
    { id: 'h3', filename: 'b.ts', line_start: 1, line_end: 2, severity: 'HIGH', issue: 'i3', fixed_code: 'fix3', category: 'correctness' },
  ]
  const r2 = [
    { id: 'h2', filename: 'a.ts', line_start: 1, line_end: 2, severity: 'HIGH', issue: 'i2', fixed_code: 'fix2', category: 'correctness' },
    { id: 'h4', filename: 'b.ts', line_start: 3, line_end: 4, severity: 'HIGH', issue: 'i4', fixed_code: 'fix4', category: 'correctness' },
  ]
  const result = mergeReviewHunks(r1, r2, { 'a.ts': 'l1\nl2', 'b.ts': 'l1\nl2\nl3\nl4' })
  assert(result.conflicts.length === 1, 'Only a.ts produces a conflict (same lines)')
  // b.ts has two non-overlapping hunks (R1 on 1-2, R2 on 3-4) — both resolved
  assert(result.resolved.length === 2, 'b.ts non-overlapping hunks both resolved')
  assert(result.conflicts[0].filename === 'a.ts', 'Conflict is on a.ts')
  assert(result.resolved.every(h => h.filename === 'b.ts'), 'All resolved are on b.ts')
}

// ── Test 8: applyResolvedHunks — anchor-based (with original_code) ────────────
console.log('\nTest 8: applyResolvedHunks anchor-based replacement')
{
  const code = 'function foo() {\n  const x = 1\n  return x\n}\n\nfunction bar() {\n  return 42\n}'
  const hunks = [
    {
      filename: file,
      line_start: 2,
      line_end: 2,
      original_code: '  const x = 1',
      new_code: '  const x = 99',
      source: 'R1',
      flag_ids: [],
    },
  ]
  const { code: result, failedHunks } = applyResolvedHunks(code, hunks)
  assert(result.includes('const x = 99'), 'Anchor replacement applied correctly')
  assert(!result.includes('const x = 1'), 'Old code removed')
  assert(failedHunks.length === 0, 'No failed hunks')
}

// ── Test 9: applyResolvedHunks — failed anchor → goes to failedHunks ─────────
console.log('\nTest 9: applyResolvedHunks — unlocatable anchor returns in failedHunks')
{
  const code = 'function foo() {\n  return 1\n}'
  const hunks = [
    {
      filename: file,
      line_start: 1,
      line_end: 1,
      original_code: 'THIS TEXT DOES NOT EXIST',
      new_code: 'replacement',
      source: 'R1',
      flag_ids: ['bad_hunk'],
    },
  ]
  const { code: result, failedHunks } = applyResolvedHunks(code, hunks)
  assert(result === code, 'Code unchanged when anchor not found')
  assert(failedHunks.length === 1, 'One failed hunk returned')
  assert(failedHunks[0].flag_ids[0] === 'bad_hunk', 'Correct hunk in failedHunks')
}

// ── Test 10: locateInFile — exact match, nearest to hint ─────────────────────
console.log('\nTest 10: locateInFile returns correct position')
{
  const code = 'a\nb\nc\na\nb\nc'  // 'a\nb\nc' appears at lines 1-3 and 4-6
  const loc1 = locateInFile(code, 'a\nb\nc', 1)
  assert(loc1?.lineStart === 1, 'Nearest to hint=1 → line 1')
  const loc2 = locateInFile(code, 'a\nb\nc', 5)
  assert(loc2?.lineStart === 4, 'Nearest to hint=5 → line 4')
}

// ── Test 11: mergeReviewHunks — anchor-based overlap detection ───────────────
console.log('\nTest 11: mergeReviewHunks uses anchor positions for overlap detection')
{
  // Two hunks whose line hints don't overlap, but anchors DO (e.g., one anchor
  // spans multiple lines that the other hunk's line hint says are separate).
  // Using actual line content so anchors locate correctly.
  const fileContent = 'alpha\nbeta\ngamma\ndelta\nepsilon'
  const r1 = [{
    id: 'h1', filename: file, line_start: 1, line_end: 3,
    original_code: 'alpha\nbeta\ngamma',
    severity: 'HIGH', issue: 'r1 fix', fixed_code: 'FIXED_R1', category: 'correctness',
  }]
  const r2 = [{
    id: 'h2', filename: file, line_start: 2, line_end: 4,
    original_code: 'beta\ngamma\ndelta',
    severity: 'HIGH', issue: 'r2 fix', fixed_code: 'FIXED_R2', category: 'correctness',
  }]
  const result = mergeReviewHunks(r1, r2, { [file]: fileContent })
  assert(result.conflicts.length === 1, 'Overlapping anchors detected as conflict')
  assert(result.resolved.length === 0, 'No resolved when anchor-detected overlap')
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`)
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
