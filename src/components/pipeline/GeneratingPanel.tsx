'use client'

import { useRef, useEffect, useState } from 'react'
import { usePipelineState } from '@/store'

function PhaseStep({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={
        done   ? 'text-green-500' :
        active ? 'text-indigo-400 animate-pulse' :
                 'text-zinc-700'
      }>
        {done ? '✓' : active ? '●' : '○'}
      </span>
      <span className={`text-xs ${done ? 'text-zinc-400' : active ? 'text-zinc-200' : 'text-zinc-600'}`}>
        {label}
      </span>
    </div>
  )
}

function detectCurrentFile(code: string): string | null {
  const match = [...code.matchAll(/=== FILE: (.+?) ===/g)].at(-1)
  return match ? match[1]!.trim() : null
}

export function GeneratingPanel({ label }: { label?: string }) {
  const {
    streamingCode, selfCheckOutput, reviewerEdit, coderVerification,
    phase, round, project,
  } = usePipelineState()
  const codeEndRef   = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)

  const currentFile = phase === 'phase3_generating' ? detectCurrentFile(streamingCode) : null

  useEffect(() => {
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      codeEndRef.current?.scrollIntoView({ behavior: 'instant' })
      scrollRafRef.current = null
    })
  }, [streamingCode])

  async function copyCode() {
    await navigator.clipboard.writeText(streamingCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const isGenerating   = phase === 'phase3_generating'
  const isSelfCheck    = phase === 'phase3_self_check'
  const isReviewing    = phase === 'phase3_reviewing'
  const isReviewerEdit = phase === 'phase3_reviewer_edit'
  const isCoderVerify  = phase === 'phase3_coder_verify'
  const isConsensus    = phase === 'phase3_consensus'

  const pastGeneration = !isGenerating && !!streamingCode
  const pastReview     = isReviewerEdit || isCoderVerify || isConsensus
  const pastEdit       = isCoderVerify || (isConsensus && !!reviewerEdit)

  const headerLabel = label ??
    (isReviewerEdit ? 'Reviewer editing code…' :
     isCoderVerify  ? 'Coder verifying reviewer\'s changes…' :
     isReviewing    ? 'Reviewing…' :
     currentFile    ? `Generating ${currentFile}…` :
                      `Phase 3 — Code Generation ${round > 1 ? `(round ${round})` : ''}`)

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-medium text-zinc-300">{headerLabel}</h2>
          {streamingCode && (
            <button
              onClick={copyCode}
              className="shrink-0 rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
          <PhaseStep
            label={`Generate (${project?.primaryModelId ?? 'primary'})`}
            active={isGenerating}
            done={pastGeneration}
          />
          <PhaseStep
            label="Self-Check"
            active={isSelfCheck}
            done={!isSelfCheck && !!selfCheckOutput}
          />
          <PhaseStep
            label={`Review (${project?.reviewerModelId ?? 'reviewer'})`}
            active={isReviewing}
            done={pastReview}
          />
          <PhaseStep
            label="Reviewer Edits"
            active={isReviewerEdit}
            done={pastEdit}
          />
          <PhaseStep
            label="Coder Verifies"
            active={isCoderVerify}
            done={(!!coderVerification && !isCoderVerify) || (isConsensus && !!coderVerification)}
          />
        </div>
      </div>

      {/* Self-check status */}
      {selfCheckOutput && (
        <div className={`border-b px-6 py-2 text-xs ${selfCheckOutput.all_clear ? 'border-green-900/30 bg-green-950/10 text-green-400' : 'border-yellow-900/30 bg-yellow-950/10 text-yellow-400'}`}>
          Self-check pass {selfCheckOutput.pass}/2: {selfCheckOutput.all_clear ? 'All clear' : `${selfCheckOutput.issues.length} issue(s) — patching…`}
        </div>
      )}

      {/* Reviewer edit status */}
      {reviewerEdit && (
        <div className="border-b border-indigo-900/30 bg-indigo-950/10 px-6 py-2 text-xs text-indigo-400">
          Reviewer produced {reviewerEdit.hunks.length} edit{reviewerEdit.hunks.length !== 1 ? 's' : ''} — {reviewerEdit.reasoning.slice(0, 80)}{reviewerEdit.reasoning.length > 80 ? '…' : ''}
        </div>
      )}

      {/* Coder verification status */}
      {coderVerification && (
        <div className={`border-b px-6 py-2 text-xs ${coderVerification.agrees ? 'border-green-900/30 bg-green-950/10 text-green-400' : 'border-yellow-900/30 bg-yellow-950/10 text-yellow-400'}`}>
          Coder {coderVerification.agrees
            ? `accepts all ${coderVerification.accepted_hunks.length} change(s) — entering consensus`
            : `disputes ${coderVerification.rejected_hunks.length} change(s) — entering dialogue`}
        </div>
      )}

      {/* Streaming code */}
      <div className="flex-1 overflow-y-auto">
        {streamingCode ? (
          <pre className="min-h-full p-4 font-mono text-xs text-zinc-300 whitespace-pre-wrap">
            {streamingCode}
            {isGenerating && <span className="inline-block w-1.5 h-3 bg-indigo-400 animate-pulse ml-0.5 align-middle" />}
          </pre>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-zinc-600 animate-pulse">
              {isReviewerEdit ? 'Reviewer editing…' : isCoderVerify ? 'Coder evaluating…' : 'Starting generation…'}
            </p>
          </div>
        )}
        <div ref={codeEndRef} />
      </div>
    </div>
  )
}
