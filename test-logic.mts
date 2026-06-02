/**
 * Pure-logic unit tests — no API keys, no Redis, no network.
 * Tests every stateless function in the pipeline.
 *
 * Run with:  npx tsx test-logic.mts
 */

// ─── Minimal test harness ─────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}${detail ? `\n    → ${detail}` : ''}`)
    failed++
  }
}

function group(name: string, fn: () => void) {
  console.log(`\n${name}`)
  fn()
}

// ─── Imports (using relative paths since this file is excluded from tsconfig) ──

import { runPhase0Context } from './src/lib/pipeline/phase0-context.js'
import { detectContradictions } from './src/lib/pipeline/phase2-contradiction.js'
import { formatHumanOverride, hasAcknowledgedOverride, hasDismissedOverride, consumePendingOverrides } from './src/lib/pipeline/human-override.js'
import { estimateTokens, truncateToTokenLimit, trimHistoryToTokenLimit } from './src/lib/utils/tokens.js'
import { parseThinkingOutput, parseReviewPayload, parseSelfCheckOutput } from './src/lib/adapters/base.js'

// ─── Phase 0: Context normalization ──────────────────────────────────────────

group('Phase 0 — runPhase0Context', () => {
  const r1 = runPhase0Context({ text: '  hello world  ' })
  assert(r1.contextText === 'hello world', 'trims whitespace')

  const r2 = runPhase0Context({})
  assert(r2.contextText === '', 'empty input → empty string')

  const r3 = runPhase0Context({ files: ['a.ts', 'b.ts'], text: 'some code' })
  assert(r3.contextText.includes('Files included: a.ts, b.ts'), 'includes file list')
  assert(r3.contextText.includes('some code'), 'includes text content')

  const longText = 'x'.repeat(100_000)
  const r4 = runPhase0Context({ text: longText })
  const tokenEstimate = r4.contextText.length / 4
  assert(tokenEstimate <= 10_000 + 50, 'truncates to ≤10k tokens', `got ~${Math.round(tokenEstimate)} tokens`)
})

// ─── Phase 2: Contradiction detection ────────────────────────────────────────

group('Phase 2 — detectContradictions', () => {
  const questions = [
    {
      id: 'q1', text: 'Architecture style?', category: 'core_behavior' as const,
      source: 'primary' as const, is_required: true, recommendation_reason: '',
      options: [
        { id: 'o1', label: 'Stateless REST', description: 'no server state' },
        { id: 'o2', label: 'Stateful service', description: 'with server sessions' },
      ],
    },
    {
      id: 'q2', text: 'Session management?', category: 'core_behavior' as const,
      source: 'reviewer' as const, is_required: false, recommendation_reason: '',
      options: [
        { id: 'o3', label: 'Session storage required', description: 'needs server sessions' },
        { id: 'o4', label: 'No session needed', description: 'stateless only' },
      ],
    },
  ]

  // Contradiction: stateless + session storage
  const c1 = detectContradictions(questions, { q1: 'o1', q2: 'o3' })
  assert(c1.length > 0, 'detects stateless↔session contradiction')
  assert(c1[0]!.resolution_options.length >= 2, 'provides resolution options')

  // No contradiction: both stateless
  const c2 = detectContradictions(questions, { q1: 'o1', q2: 'o4' })
  assert(c2.length === 0, 'no contradiction when choices are compatible')

  // Only one question answered — no pair to compare
  const c3 = detectContradictions(questions, { q1: 'o1' })
  assert(c3.length === 0, 'single answered question cannot contradict')

  // No answers at all
  const c4 = detectContradictions(questions, {})
  assert(c4.length === 0, 'empty answers → no contradictions')
})

// ─── Human override formatting ────────────────────────────────────────────────

group('human-override — formatHumanOverride', () => {
  const msg = formatHumanOverride('Use approach A, not B')
  assert(msg.startsWith('HUMAN OVERRIDE:'), 'starts with prefix')
  assert(msg.includes('Use approach A, not B'), 'contains the message')
  assert(msg.includes('subordinate'), 'includes subordination clause')
  assert(msg.includes('Acknowledge explicitly'), 'includes ACK requirement')
})

group('human-override — hasAcknowledgedOverride', () => {
  assert(hasAcknowledgedOverride('Acknowledged: I will use approach A'), 'detects "Acknowledged:"')
  assert(hasAcknowledgedOverride('Understood. Proceeding with A.'), 'detects "Understood"')
  assert(hasAcknowledgedOverride('I acknowledge the directive.'), 'detects "I acknowledge"')
  assert(hasAcknowledgedOverride('Confirmed, will do.'), 'detects "Confirmed"')
  assert(!hasAcknowledgedOverride('Yes this is noted in my context'), 'does not match bare "noted"')
  assert(!hasAcknowledgedOverride(''), 'empty string → false')
})

group('human-override — hasDismissedOverride', () => {
  assert(hasDismissedOverride('Noted, however the architecture requires...'), 'detects "noted, however"')
  assert(hasDismissedOverride('Understood, but I still think...'), 'detects "understood, but"')
  assert(!hasDismissedOverride('Acknowledged: I will change the approach.'), 'genuine ACK → not dismissed')
})

group('human-override — consumePendingOverrides', () => {
  assert(consumePendingOverrides([]) === null, 'empty list → null')
  const single = consumePendingOverrides(['do X'])
  assert(single !== null && single.includes('do X'), 'single override included')
  const multi = consumePendingOverrides(['do X', 'do Y'])
  assert(multi !== null && multi.includes('Override 1:') && multi.includes('Override 2:'), 'multiple overrides numbered')
})

// ─── Token utilities ──────────────────────────────────────────────────────────

group('tokens — estimateTokens', () => {
  assert(estimateTokens('') === 0, 'empty string → 0')
  assert(estimateTokens('hello') === 2, '"hello" (5 chars / 4 ≈ 2 tokens)')
  assert(estimateTokens('a'.repeat(400)) === 100, '400 chars → 100 tokens')
})

group('tokens — truncateToTokenLimit', () => {
  const text = 'word '.repeat(1000).trim()    // 5000 chars ~ 1250 tokens
  const cut  = truncateToTokenLimit(text, 100) // 400 chars limit
  assert(cut.length <= 420, 'output is within ~5% of token limit in chars')
  assert(cut.includes('[...truncated]'), 'appends truncation marker')
  assert(!cut.endsWith(' '), 'does not end with mid-word split')

  // Short text passes through unchanged
  const short = 'Hello world'
  assert(truncateToTokenLimit(short, 1000) === short, 'short text unchanged')
})

group('tokens — trimHistoryToTokenLimit', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({
    role: 'user' as const,
    content: 'message content here '.repeat(10),
    timestamp: i,
  }))
  const trimmed = trimHistoryToTokenLimit(messages, 200)
  assert(trimmed.length < messages.length, 'removes old messages to fit limit')
  // The kept messages should be the most recent
  const lastKeptIdx = messages.indexOf(trimmed[0]!)
  assert(lastKeptIdx > 0, 'discards oldest messages first')
})

// ─── JSON parsers (fallback paths) ────────────────────────────────────────────

group('parseThinkingOutput — fallbacks', () => {
  const out1 = parseThinkingOutput('not json at all', 'deepseek', 'model-x', 100)
  assert(out1.provider === 'deepseek', 'fallback preserves provider')
  assert(out1.model_id === 'model-x', 'fallback preserves model_id')
  assert(out1.tokens_used === 100, 'fallback preserves token count')
  assert(out1.risks.length > 0, 'fallback includes parse-failure risk message')
  assert(out1.questions.length === 0, 'fallback has empty questions')
  assert(out1.assumptions.length === 0, 'fallback has empty assumptions')

  // Partial JSON that passes schema
  const partial = JSON.stringify({
    understood_as: 'a task',
    assumptions: [],
    questions: [],
    recommended_approach: 'do it simply',
    risks: [],
  })
  const out2 = parseThinkingOutput(partial, 'anthropic', 'claude', 50)
  assert(out2.understood_as === 'a task', 'valid JSON parsed correctly')
  assert(out2.risks.length === 0, 'valid JSON has no synthetic risks')
})

group('parseReviewPayload — fallbacks', () => {
  // Truncated JSON (ends mid-string)
  const truncated = '{"consensus": false, "round": 1, "flags": [], "critical_bugs": ["bug1"'
  const r1 = parseReviewPayload(truncated, 1)
  assert(!r1.consensus, 'truncated → consensus false')
  assert(r1.critical_bugs.some(b => b.includes('truncated') || b.includes('malformed')), 'truncation detected')

  // Valid JSON
  const valid = JSON.stringify({
    consensus: true, round: 2, flags: [],
    critical_bugs: [], logic_errors: [], edge_cases_missed: [],
    pseudo_code_hints: [], reasoning: 'looks good',
    dependencies_rechecked: true,
  })
  const r2 = parseReviewPayload(valid, 2)
  assert(r2.consensus === true, 'valid JSON: consensus true')
  assert(r2.round === 2, 'valid JSON: round preserved')
  assert(r2.reasoning === 'looks good', 'valid JSON: reasoning preserved')
})

group('parseSelfCheckOutput — fallbacks', () => {
  const bad = parseSelfCheckOutput('garbage', 1)
  assert(bad.pass === 1, 'fallback preserves pass number')
  assert(!bad.all_clear, 'fallback → not all clear')

  const good = JSON.stringify({
    pass: 1, issues: [], all_clear: true, reasoning: 'clean',
  })
  const ok = parseSelfCheckOutput(good, 1)
  assert(ok.all_clear === true, 'valid JSON: all_clear true')
  assert(ok.issues.length === 0, 'valid JSON: no issues')
})

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
