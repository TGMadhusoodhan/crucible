'use client'

import { useState } from 'react'
import { usePipeline } from '@/hooks/usePipeline'
import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'
import type { Question, QuestionOption } from '@/types'

const CATEGORY_LABELS: Record<string, string> = {
  core_behavior:  'Core Behavior',
  security:       'Security',
  error_handling: 'Error Handling',
  edge_cases:     'Edge Cases',
  integration:    'Integration',
}

function OptionButton({
  option,
  selected,
  recommended,
  onClick,
}: {
  option: QuestionOption
  selected: boolean
  recommended: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left rounded border px-3 py-2 text-xs transition-colors',
        selected
          ? 'border-indigo-500 bg-indigo-950/60 text-indigo-200'
          : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{option.label}</span>
        {recommended && !selected && (
          <span className="shrink-0 rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-500">
            recommended
          </span>
        )}
        {recommended && selected && (
          <span className="shrink-0 rounded bg-indigo-900/60 px-1 py-0.5 text-[10px] text-indigo-400">
            ✓ recommended
          </span>
        )}
      </div>
      <p className="mt-0.5 text-zinc-500">{option.description}</p>
      {option.tradeoffs && (
        <p className="mt-0.5 text-yellow-700 text-[10px]">{option.tradeoffs}</p>
      )}
    </button>
  )
}

function QuestionCard({
  question,
  answer,
  onAnswer,
}: {
  question: Question
  answer:   string | undefined
  onAnswer: (optionId: string) => void
}) {
  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-start gap-2">
        <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
          {CATEGORY_LABELS[question.category] ?? question.category}
        </span>
        {question.is_required && (
          <span className="shrink-0 rounded bg-red-950/40 px-1.5 py-0.5 text-[10px] text-red-500">
            required
          </span>
        )}
      </div>

      <p className="text-sm text-zinc-200">{question.text}</p>

      {question.recommendation_reason && (
        <p className="text-xs text-zinc-600 italic">
          Model recommends: {question.recommendation_reason}
        </p>
      )}

      <div className="space-y-1.5">
        {question.options.map(opt => (
          <OptionButton
            key={opt.id}
            option={opt}
            selected={answer === opt.id}
            recommended={question.recommended_option_id === opt.id}
            onClick={() => onAnswer(opt.id)}
          />
        ))}
      </div>
    </div>
  )
}

export function QuestionsPanel() {
  const { questions, userAnswers, contradiction, phase } = usePipelineState()
  const { submitAnswers, answerQuestion } = usePipeline()
  const [submitting, setSubmitting]   = useState(false)
  const [showAuto,   setShowAuto]     = useState(false)
  const [error, setError]             = useState<string | null>(null)

  // Split into groups: required (must answer), auto-decided (recommended, non-required), free optional
  const required  = questions.filter(q => q.is_required)
  const autoDone  = questions.filter(q => !q.is_required && q.recommended_option_id)
  const freeOpt   = questions.filter(q => !q.is_required && !q.recommended_option_id)

  const allRequiredAnswered = required.every(q => userAnswers[q.id] !== undefined)

  function buildFinalAnswers() {
    const final = { ...userAnswers }
    for (const q of questions) {
      if (!final[q.id] && q.recommended_option_id) {
        final[q.id] = q.recommended_option_id
      }
    }
    return final
  }

  async function handleSubmit() {
    if (!allRequiredAnswered) return
    setError(null)
    setSubmitting(true)
    try {
      await submitAnswers(buildFinalAnswers())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (phase === 'phase2_contradiction_check' && contradiction) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6">
        <div className="w-full max-w-xl space-y-4">
          <div className="rounded-lg border border-yellow-800/50 bg-yellow-950/20 p-5 space-y-2">
            <h3 className="text-sm font-medium text-yellow-400">⚠ Contradiction Detected</h3>
            <p className="text-xs text-zinc-300">{contradiction.description}</p>
            <p className="text-xs text-zinc-500">
              Your answers conflict. Select a resolution to continue:
            </p>
          </div>

          <div className="space-y-2">
            {contradiction.resolution_options.map((opt) => (
              <button
                key={opt.id}
                disabled={submitting}
                onClick={async () => {
                  // Build final answers by applying resolution changes on top of current
                  // answers + all recommended defaults. Cannot rely on answerQuestion
                  // dispatch updating userAnswers synchronously within this closure.
                  const merged: Record<string, string> = { ...userAnswers, ...opt.changes }
                  for (const q of questions) {
                    if (!merged[q.id] && q.recommended_option_id) {
                      merged[q.id] = q.recommended_option_id
                    }
                  }
                  setError(null)
                  setSubmitting(true)
                  try {
                    await submitAnswers(merged)
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Submit failed')
                  } finally {
                    setSubmitting(false)
                  }
                }}
                className="w-full text-left rounded border border-zinc-700 bg-zinc-900 px-4 py-3 text-xs text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {opt.description}
              </button>
            ))}
          </div>

          {error && (
            <p className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}
          {submitting && (
            <p className="text-xs text-zinc-500 text-center animate-pulse">Applying resolution…</p>
          )}
        </div>
      </div>
    )
  }

  const requiredRemaining = required.filter(q => !userAnswers[q.id]).length

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-zinc-300">Phase 2 — Questions</h2>
          <p className="text-xs text-zinc-600">
            {requiredRemaining > 0
              ? `${requiredRemaining} decision${requiredRemaining !== 1 ? 's' : ''} needed`
              : required.length > 0 ? 'All answered — ready to continue' : 'No required decisions'}
            {autoDone.length > 0 && ` · ${autoDone.length} auto-decided`}
          </p>
        </div>

        <button
          onClick={handleSubmit}
          disabled={!allRequiredAnswered || submitting}
          className={cn(
            'rounded px-4 py-1.5 text-xs font-medium transition-colors',
            allRequiredAnswered && !submitting
              ? 'bg-indigo-600 text-white hover:bg-indigo-500'
              : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
          )}
        >
          {submitting ? 'Submitting…' : 'Continue →'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {error && (
          <p className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-400">
            {error}
          </p>
        )}

        {/* Required questions — must answer */}
        {required.length > 0 && (
          <div className="space-y-4">
            {required.map(q => (
              <QuestionCard
                key={q.id}
                question={q}
                answer={userAnswers[q.id]}
                onAnswer={optionId => answerQuestion(q.id, optionId)}
              />
            ))}
          </div>
        )}

        {/* Free optional questions — no recommendation */}
        {freeOpt.length > 0 && (
          <div className="space-y-4">
            {freeOpt.map(q => (
              <QuestionCard
                key={q.id}
                question={q}
                answer={userAnswers[q.id]}
                onAnswer={optionId => answerQuestion(q.id, optionId)}
              />
            ))}
          </div>
        )}

        {/* Auto-decided — collapsed by default, expandable */}
        {autoDone.length > 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40">
            <button
              onClick={() => setShowAuto(v => !v)}
              className="flex w-full items-center justify-between px-4 py-2.5 text-left"
            >
              <span className="text-xs text-zinc-500">
                {showAuto ? '▾' : '▸'} {autoDone.length} auto-decided by model recommendation
              </span>
              <span className="text-[10px] text-zinc-600">click to review or override</span>
            </button>
            {showAuto && (
              <div className="border-t border-zinc-800 p-4 space-y-4">
                {autoDone.map(q => (
                  <QuestionCard
                    key={q.id}
                    question={q}
                    answer={userAnswers[q.id] ?? q.recommended_option_id}
                    onAnswer={optionId => answerQuestion(q.id, optionId)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
