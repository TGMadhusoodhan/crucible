/**
 * Full 4-phase pipeline integration test.
 * Tests the complete flow: thinking → alignment → questions → spec → generate → review → consensus.
 *
 * Run with:
 *   DEEPSEEK_KEY=<key> ANTHROPIC_KEY=<key> npx tsx test-pipeline.mts
 *
 * Both keys required. Expected runtime: ~2–4 minutes (model latency).
 */

// ─── Env check ────────────────────────────────────────────────────────────────

const DEEPSEEK_KEY  = process.env.DEEPSEEK_KEY  ?? ''
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY ?? ''

if (!DEEPSEEK_KEY || !ANTHROPIC_KEY) {
  console.error('\n  Set DEEPSEEK_KEY and ANTHROPIC_KEY environment variables.\n')
  process.exit(1)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString().slice(11, 19) }
function log(msg: string) { console.log(`[${ts()}] ${msg}`) }
function hr(label: string) { console.log(`\n${'━'.repeat(60)}\n  ${label}\n${'━'.repeat(60)}`) }

// ─── Imports ──────────────────────────────────────────────────────────────────

import { getAdapter }             from './src/lib/adapters/index.js'
import { runPhase1Thinking }      from './src/lib/pipeline/phase1-thinking.js'
import { runPhase1_5Alignment }   from './src/lib/pipeline/phase1-5-alignment.js'
import { runPhase2Questions }     from './src/lib/pipeline/phase2-questions.js'
import { detectContradictions }   from './src/lib/pipeline/phase2-contradiction.js'
import { runPhase2Spec }          from './src/lib/pipeline/phase2-spec.js'
import { runPhase3Generate }      from './src/lib/pipeline/phase3-generate.js'
import { runPhase3Review }        from './src/lib/pipeline/phase3-review.js'
import { runPhase3Consensus }     from './src/lib/pipeline/phase3-consensus.js'
import type {
  AlignmentResult,
  PipelineContext,
  Question,
  SpecDocument,
  ThinkingOutput,
} from './src/types/index.js'

// ─── Adapters ─────────────────────────────────────────────────────────────────

const primary  = getAdapter('deepseek',   'DeepSeek-V4-Pro',    DEEPSEEK_KEY)
const reviewer = getAdapter('anthropic', 'claude-sonnet-4-6',  ANTHROPIC_KEY)

const emit = (event: { type: string }) => {
  if (event.type === 'token' || event.type === 'phase_change') return
  log(`  [${event.type}]`)
}

// ─── Task ─────────────────────────────────────────────────────────────────────

const PROJECT_ID = 'test-project'
const SESSION_ID = `test-${Date.now()}`
const TASK = `Write a TypeScript function parseCSV(text: string): string[][] that:
1. Splits input on newlines into rows
2. Splits each row on commas into fields
3. Handles quoted fields (fields may contain commas if wrapped in double-quotes)
4. Strips surrounding whitespace from field values
5. Returns an empty array for empty input`

// ─── Phase 1: Parallel Thinking ───────────────────────────────────────────────

hr('PHASE 1 — Parallel Thinking')
log('Both models think independently…')

const phase1 = await runPhase1Thinking(
  PROJECT_ID, SESSION_ID, TASK, primary, reviewer, emit,
)

const thinkingPrimary:  ThinkingOutput = phase1.primary
const thinkingReviewer: ThinkingOutput = phase1.reviewer

log(`Primary   (${thinkingPrimary.model_id}): ${thinkingPrimary.understood_as}`)
log(`Reviewer  (${thinkingReviewer.model_id}): ${thinkingReviewer.understood_as}`)
log(`Questions: primary=${thinkingPrimary.questions.length}, reviewer=${thinkingReviewer.questions.length}`)

if (!thinkingPrimary.understood_as || !thinkingReviewer.understood_as) {
  console.error('FAIL: One or both models returned empty understood_as'); process.exit(1)
}

// ─── Phase 1.5: Alignment ─────────────────────────────────────────────────────

hr('PHASE 1.5 — Alignment')

const alignmentResult: AlignmentResult = await runPhase1_5Alignment(
  PROJECT_ID, SESSION_ID,
  thinkingPrimary, thinkingReviewer,
  primary, reviewer, emit,
)

log(`Rounds taken: ${alignmentResult.rounds_taken}`)
log(`Mismatch: ${alignmentResult.architectural_mismatch_detected}`)
log(`Agreed questions: ${alignmentResult.agreed_questions.length}`)

// ─── Phase 2: Questions ───────────────────────────────────────────────────────

hr('PHASE 2 — Questions')

const questions: Question[] = await runPhase2Questions(
  PROJECT_ID, SESSION_ID,
  thinkingPrimary, thinkingReviewer,
  alignmentResult, emit,
)

log(`Questions: ${questions.length} total, ${questions.filter(q => q.is_required).length} required`)
questions.forEach((q, i) => log(`  ${i + 1}. [${q.category}] ${q.text}`))

if (questions.length === 0) { console.error('FAIL: No questions'); process.exit(1) }

// Auto-answer: pick recommended option or first option
const userAnswers: Record<string, string> = {}
for (const q of questions) {
  userAnswers[q.id] = q.recommended_option_id ?? q.options[0]?.id ?? ''
}
log(`Auto-answered ${Object.keys(userAnswers).length} questions (recommended/first option)`)

const contradictions = detectContradictions(questions, userAnswers)
log(`Contradictions: ${contradictions.length} (${contradictions.length === 0 ? 'none — answers consistent' : 'would surface to human'})`)

// ─── Phase 2: Spec ────────────────────────────────────────────────────────────

hr('PHASE 2 — Spec Generation')

const spec: SpecDocument = await runPhase2Spec({
  projectId: PROJECT_ID, sessionId: SESSION_ID,
  taskDescription: TASK, questions, userAnswers,
  thinkingOutputs: { primary: thinkingPrimary, reviewer: thinkingReviewer },
}, emit)

spec.human_confirmed = true
spec.confirmed_at    = new Date().toISOString()

log(`Spec: ${spec.acceptance_criteria.length} criteria, ${spec.edge_cases.length} edge cases, ${spec.error_messages.length} error scenarios`)
if (spec.acceptance_criteria.length === 0) { console.error('FAIL: Empty spec'); process.exit(1) }

// ─── Phase 3: Generation + Self-Check ────────────────────────────────────────

hr('PHASE 3 — Code Generation + Self-Check')

const ctx: PipelineContext = {
  projectId: PROJECT_ID, sessionId: SESSION_ID, spec,
  history: [], humanOverrides: [], taskDescription: TASK,
  activeMemory: {
    current_module: 'parseCSV', open_questions: [],
    file_structure: {}, recent_decisions: [],
    current_tech_stack: ['TypeScript'], unresolved_conflicts: [],
  },
}

log('Generating code (streaming)…')
process.stdout.write('\n')
let tokenCount = 0
const genResult = await runPhase3Generate(
  PROJECT_ID, SESSION_ID, 1, ctx, primary,
  (event) => {
    if (event.type === 'token') {
      process.stdout.write((event as { type: string; text: string }).text)
      tokenCount++
    }
  },
)
process.stdout.write('\n\n')

log(`Code: ${genResult.code.length} chars, ~${tokenCount} tokens streamed`)
log(`Self-check pass: ${genResult.selfCheckOutput.pass}/2, all_clear: ${genResult.selfCheckOutput.all_clear}`)
if (!genResult.selfCheckOutput.all_clear) {
  genResult.selfCheckOutput.issues.forEach(i =>
    log(`  [${i.severity.toUpperCase()}] ${i.description}`)
  )
}

if (!genResult.code || genResult.code.length < 50) {
  console.error('FAIL: Generated code too short'); process.exit(1)
}

// ─── Phase 3: Review ─────────────────────────────────────────────────────────

hr('PHASE 3 — Cross-Model Review')
log('Claude reviewing DeepSeek\'s code against the spec…')

const review = await runPhase3Review(
  PROJECT_ID, SESSION_ID, genResult.code, ctx,
  reviewer, 1, emit,
)

const highMed = review.flags.filter(f => f.severity !== 'LOW')
log(`Review: consensus=${review.consensus}, HIGH/MEDIUM flags=${highMed.length}, LOW flags=${review.flags.filter(f => f.severity === 'LOW').length}`)
highMed.forEach(f => log(`  [${f.severity}] ${f.description}${f.pseudo_code_hint ? `\n    hint: ${f.pseudo_code_hint}` : ''}`))
log(`Reasoning: ${review.reasoning.slice(0, 200)}`)

// ─── Phase 3: Consensus ───────────────────────────────────────────────────────

hr('PHASE 3 — Consensus Routing')

const decision = await runPhase3Consensus(
  PROJECT_ID, SESSION_ID, genResult.code, review, ctx, emit,
)

log(`Promote: ${decision.promote} | Escalate: ${decision.escalate}`)

// ─── Summary ──────────────────────────────────────────────────────────────────

hr('TEST COMPLETE')
log(`✓ Phase 1:   Thinking done (primary=${thinkingPrimary.questions.length}q, reviewer=${thinkingReviewer.questions.length}q)`)
log(`✓ Phase 1.5: Alignment done (${alignmentResult.rounds_taken} round${alignmentResult.rounds_taken > 1 ? 's' : ''}, mismatch=${alignmentResult.architectural_mismatch_detected})`)
log(`✓ Phase 2:   ${questions.length} questions, ${contradictions.length} contradictions, ${spec.acceptance_criteria.length} spec criteria`)
log(`✓ Phase 3:   ${genResult.code.length} chars generated, self-check pass ${genResult.selfCheckOutput.pass}/2`)
log(`✓ Phase 3:   Review consensus=${review.consensus}, decision=${decision.promote ? 'PROMOTED' : decision.escalate ? 'ESCALATED' : 'RETRY'}`)
log(`\nAll pipeline phases exercised end-to-end.`)
