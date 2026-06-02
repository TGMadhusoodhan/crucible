import { writeSpec, specExists } from '@/lib/memory/filesystem'
import { logPhaseStart, logSpecWritten } from '@/lib/memory/session-log'
import { generateId } from '@/lib/utils'
import type {
  AcceptanceCriterion,
  Contradiction,
  EdgeCase,
  ErrorScenario,
  Question,
  SpecDocument,
  SSEEvent,
  ThinkingOutput,
} from '@/types'

// ─── Spec assembly (deterministic — no model call) ────────────────────────────

function buildAcceptanceCriteria(
  questions:   Question[],
  userAnswers: Record<string, string>,
  modelDefaults: Record<string, string>,
): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = []

  // Non-edge-case, non-error-handling questions → acceptance criteria
  const relevant = questions.filter(q =>
    q.category !== 'edge_cases' && q.category !== 'error_handling'
  )

  for (const q of relevant) {
    const optionId = userAnswers[q.id] ?? modelDefaults[q.id]
    if (!optionId) continue
    const option = q.options.find(o => o.id === optionId)
    if (!option) continue

    criteria.push({
      id:          generateId(),
      description: `${q.text} → ${option.label}: ${option.description}`,
      test_case:   `Verify that ${option.description.toLowerCase().replace(/\.$/, '')}.`,
    })
  }

  return criteria
}

function buildEdgeCases(
  questions:       Question[],
  userAnswers:     Record<string, string>,
  modelDefaults:   Record<string, string>,
  thinkingOutputs: { primary: ThinkingOutput; reviewer: ThinkingOutput },
  contradictions:  Contradiction[],
): EdgeCase[] {
  const cases: EdgeCase[] = []

  // Edge case questions from the question bank
  const edgeQuestions = questions.filter(q => q.category === 'edge_cases')
  for (const q of edgeQuestions) {
    const optionId = userAnswers[q.id] ?? modelDefaults[q.id]
    const option   = optionId ? q.options.find(o => o.id === optionId) : null
    cases.push({
      id:               generateId(),
      scenario:         q.text,
      expected_behavior: option ? option.description : q.options[0]?.description ?? 'Handle gracefully',
      test_case:        `Test that: ${option?.description ?? q.options[0]?.description ?? 'the system handles this edge case correctly'}.`,
    })
  }

  // Detected answer contradictions → explicit edge cases so the generator handles them
  const seenScenarios = new Set(cases.map(c => c.scenario.toLowerCase()))
  for (const c of contradictions) {
    if (!seenScenarios.has(c.description.toLowerCase())) {
      seenScenarios.add(c.description.toLowerCase())
      const resolution = c.resolution_options[0]
      cases.push({
        id:                generateId(),
        scenario:          `Contradiction: ${c.description}`,
        expected_behavior: resolution
          ? `Resolve by: ${resolution.description}`
          : 'Handle this conflict explicitly in the implementation.',
        test_case:         `Verify the implementation handles the conflicting requirement: ${c.description}.`,
      })
    }
  }

  // Risks from both models → additional edge cases (unique risks only)
  const allRisks = [
    ...thinkingOutputs.primary.risks,
    ...thinkingOutputs.reviewer.risks,
  ]
  for (const risk of allRisks) {
    if (!seenScenarios.has(risk.toLowerCase())) {
      seenScenarios.add(risk.toLowerCase())
      cases.push({
        id:                generateId(),
        scenario:          risk,
        expected_behavior: 'System should handle this gracefully without crashing or data loss.',
        test_case:         `Verify the system handles: ${risk.toLowerCase()}.`,
      })
    }
  }

  return cases
}

function buildErrorMessages(
  questions:     Question[],
  userAnswers:   Record<string, string>,
  modelDefaults: Record<string, string>,
): ErrorScenario[] {
  const scenarios: ErrorScenario[] = []
  const errorQuestions = questions.filter(q => q.category === 'error_handling')

  for (const q of errorQuestions) {
    const optionId = userAnswers[q.id] ?? modelDefaults[q.id]
    const option   = optionId ? q.options.find(o => o.id === optionId) : null
    scenarios.push({
      id:       generateId(),
      trigger:  q.text,
      message:  option?.description ?? 'An unexpected error occurred. Please try again.',
      recovery: option?.tradeoffs ?? undefined,
    })
  }

  // Fallback: always include a generic unexpected-error scenario
  if (scenarios.length === 0) {
    scenarios.push({
      id:       generateId(),
      trigger:  'Unexpected / unhandled error',
      message:  'An unexpected error occurred. Please try again later.',
      recovery: 'Log error server-side; show user-friendly message.',
    })
  }

  return scenarios
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export interface Phase2SpecInput {
  projectId:       string
  sessionId:       string
  taskDescription: string
  questions:       Question[]
  userAnswers:     Record<string, string>
  thinkingOutputs: { primary: ThinkingOutput; reviewer: ThinkingOutput }
  contradictions?: Contradiction[]
  contextText?:    string
}

/**
 * Phase 2 — Spec generation.
 *
 * Builds a SpecDocument deterministically from questions + answers + model
 * assumptions. No extra model call — all information is already collected.
 *
 * The spec is written once (write-once guard in filesystem.ts).
 * If a spec already exists for this project, it is returned unchanged.
 */
export async function runPhase2Spec(
  input: Phase2SpecInput,
  emit:  (event: SSEEvent) => void,
): Promise<SpecDocument> {
  const { projectId, sessionId, taskDescription, questions, userAnswers, thinkingOutputs, contradictions = [], contextText } = input

  await logPhaseStart(projectId, sessionId, 'phase2_spec', 'Phase 2: Spec Generation')
  emit({ type: 'phase_change', phase: 'phase2_spec' })

  // If a spec already exists (e.g. session resumed), return it
  if (await specExists(projectId)) {
    const { readSpec } = await import('@/lib/memory/filesystem')
    const existing = await readSpec(projectId)
    if (existing) {
      emit({ type: 'spec_ready', spec: existing })
      return existing
    }
  }

  // Build model_defaults: use recommended option for questions the user didn't answer
  const modelDefaults: Record<string, string> = {}
  for (const q of questions) {
    if (!userAnswers[q.id] && q.recommended_option_id) {
      modelDefaults[q.id] = q.recommended_option_id
    }
  }

  const spec: SpecDocument = {
    id:               generateId(),
    project_id:       projectId,
    session_id:       sessionId,
    created_at:       new Date().toISOString(),
    task_description: taskDescription,
    codebase_context: contextText,
    user_decisions:   userAnswers,
    model_defaults:   modelDefaults,
    acceptance_criteria: buildAcceptanceCriteria(questions, userAnswers, modelDefaults),
    edge_cases:          buildEdgeCases(questions, userAnswers, modelDefaults, thinkingOutputs, contradictions),
    error_messages:      buildErrorMessages(questions, userAnswers, modelDefaults),
    human_confirmed:  false,
  }

  await writeSpec(projectId, spec)
  await logSpecWritten(projectId, sessionId, spec)
  emit({ type: 'spec_ready', spec })

  return spec
}
