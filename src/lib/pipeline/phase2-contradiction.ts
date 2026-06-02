import { generateId } from '@/lib/utils'
import type { Contradiction, ContradictionResolution, Question } from '@/types'

// ─── Incompatibility rule pairs ───────────────────────────────────────────────
// Each entry defines a pair of option label keywords that are semantically
// incompatible. If the user's chosen options both match these keywords, a
// contradiction is flagged.

interface IncompatibilityRule {
  termA: string   // keyword in option label A (lowercase)
  termB: string   // keyword in option label B (lowercase)
  description: string
}

const RULES: IncompatibilityRule[] = [
  { termA: 'stateless',  termB: 'session',     description: 'Stateless architecture conflicts with server-side session storage.' },
  { termA: 'no auth',    termB: 'per-user',    description: 'No authentication conflicts with per-user data isolation.' },
  { termA: 'read-only',  termB: 'write',       description: 'Read-only access conflicts with write operations.' },
  { termA: 'synchronous',termB: 'non-blocking', description: 'Synchronous processing conflicts with non-blocking I/O.' },
  { termA: 'public',     termB: 'private',     description: 'Public access conflicts with private/restricted access.' },
  { termA: 'no cache',   termB: 'cached',      description: 'No caching conflicts with a cached response strategy.' },
  { termA: 'single',     termB: 'multi',       description: 'Single-instance approach conflicts with multi-instance requirement.' },
]

// ─── Detection ────────────────────────────────────────────────────────────────

function optionLabelFor(question: Question, optionId: string): string {
  return question.options.find(o => o.id === optionId)?.label.toLowerCase() ?? ''
}

// Returns true if the label ENDORSES the keyword (not negates it).
// "No session needed" contains "session" but is a negation — must not match.
function endorses(label: string, keyword: string): boolean {
  const idx = label.indexOf(keyword)
  if (idx === -1) return false
  // Check up to 12 chars before the keyword for negation words
  const prefix = label.slice(Math.max(0, idx - 12), idx)
  return !/\b(no|not|without|non|never)\s+$/.test(prefix)
}

function matchesRule(labelA: string, labelB: string, rule: IncompatibilityRule): boolean {
  return (endorses(labelA, rule.termA) && endorses(labelB, rule.termB)) ||
         (endorses(labelA, rule.termB) && endorses(labelB, rule.termA))
}

function buildResolutionOptions(
  qA: Question, answerA: string,
  qB: Question, answerB: string,
): ContradictionResolution[] {
  return [
    {
      id:          generateId(),
      description: `Keep "${optionLabelFor(qA, answerA)}" — change "${qB.text}" to match`,
      changes:     { [qB.id]: qB.options[0]?.id ?? answerB },
    },
    {
      id:          generateId(),
      description: `Keep "${optionLabelFor(qB, answerB)}" — change "${qA.text}" to match`,
      changes:     { [qA.id]: qA.options[0]?.id ?? answerA },
    },
  ]
}

/**
 * Phase 2 — Contradiction detection.
 *
 * Checks all pairs of answered questions for incompatible option combinations.
 * Uses a keyword-based rule table — no model call required.
 * Returns at most one Contradiction per rule match to avoid overwhelming the user.
 *
 * Future upgrade: replace rule table with a reviewer model call for richer detection.
 */
export function detectContradictions(
  questions:   Question[],
  userAnswers: Record<string, string>,
): Contradiction[] {
  const answeredQuestions = questions.filter(q => userAnswers[q.id] !== undefined)
  const contradictions: Contradiction[] = []

  for (let i = 0; i < answeredQuestions.length; i++) {
    for (let j = i + 1; j < answeredQuestions.length; j++) {
      const qA      = answeredQuestions[i]!
      const qB      = answeredQuestions[j]!
      const labelA  = optionLabelFor(qA, userAnswers[qA.id]!)
      const labelB  = optionLabelFor(qB, userAnswers[qB.id]!)

      for (const rule of RULES) {
        if (matchesRule(labelA, labelB, rule)) {
          contradictions.push({
            id:                 generateId(),
            question_a_id:      qA.id,
            question_b_id:      qB.id,
            chosen_answer_a:    userAnswers[qA.id]!,
            chosen_answer_b:    userAnswers[qB.id]!,
            description:        rule.description,
            resolution_options: buildResolutionOptions(qA, userAnswers[qA.id]!, qB, userAnswers[qB.id]!),
          })
          break  // one contradiction per question pair is enough
        }
      }
    }
  }

  return contradictions
}
