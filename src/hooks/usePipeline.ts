'use client'

import { useCallback, useRef } from 'react'
import { usePipelineDispatch, usePipelineState, type ProjectConfig } from '@/store'
import type { BudgetStatus, SSEEvent } from '@/types'

// ─── SSE connection ───────────────────────────────────────────────────────────

function connectSSE(
  sessionId: string,
  onEvent:   (event: SSEEvent) => void,
  signal:    AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    fetch(`/api/pipeline/stream?sessionId=${sessionId}`, { signal })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => 'unknown error')
          reject(new Error(`Stream failed: ${res.status} ${text}`))
          return
        }

        const reader  = res.body.getReader()
        const decoder = new TextDecoder()
        let   buffer  = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (line.startsWith(':')) continue          // heartbeat comment
            if (!line.startsWith('data: ')) continue   // skip non-data lines
            try {
              const event = JSON.parse(line.slice(6)) as SSEEvent
              onEvent(event)
            } catch { /* skip malformed chunks */ }
          }
        }
        resolve()
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') resolve()
        else reject(err instanceof Error ? err : new Error(String(err)))
      })
  })
}

// ─── Main hook ────────────────────────────────────────────────────────────────

// Phases where the client must NOT auto-reconnect: human-input gates and
// terminal states. Every other phase means the pipeline still has work to do
// and the client should reconnect immediately for the next invocation.
const NO_AUTO_RECONNECT = new Set([
  'idle',
  'phase2_answering',
  'phase2_confirm',
  'phase3_micro_gate',
  'phase3_arbitration',
  'output_gate',
  'paused',
  'stopped',
  'complete',
  'error',
])

// Phases that are internal pipeline phases (not human gates).
// When stream closes at these, client reconnects automatically.
// phase1_thinking, phase1_5_alignment, phase2_questions, phase2_contradiction_check,
// phase2_spec_and_manifest, phase3_generating, phase3_reviewing, phase3_cross_review,
// phase3_patching, phase3_re_review are all pipeline-internal phases handled within
// one stream session or auto-reconnected.

export function usePipeline() {
  const state    = usePipelineState()
  const dispatch = usePipelineDispatch()
  const abortRef = useRef<AbortController | null>(null)
  // Tracks the last phase received via SSE so connectToStream can decide
  // whether to auto-reconnect after the stream closes.
  const lastPhaseRef      = useRef<string>('idle')
  const reconnectCountRef = useRef<number>(0)
  const MAX_AUTO_RECONNECTS = 10
  const tokenBufferRef = useRef<string>('')
  const rafRef         = useRef<number | null>(null)

  // ─── Event dispatcher ──────────────────────────────────────────────────────

  const handleSSEEvent = useCallback((event: SSEEvent) => {
    switch (event.type) {
      case 'phase_change':
        lastPhaseRef.current = event.phase
        dispatch({ type: 'SET_PHASE', phase: event.phase })
        break
      case 'error':
        dispatch({ type: 'SET_ERROR', message: event.message })
        break
      case 'done':
        dispatch({ type: 'STREAM_END' })
        break
      case 'budget_update':
        dispatch({ type: 'BUDGET_UPDATE', budget: event.budget })
        break
      case 'heartbeat':
        break
      case 'thinking_done':
        dispatch({ type: 'THINKING_DONE', actor: event.actor, output: event.output })
        break
      case 'alignment_msg':
        dispatch({ type: 'ALIGNMENT_MSG', message: event.message })
        break
      case 'questions_ready':
        dispatch({ type: 'QUESTIONS_READY', questions: event.questions })
        break
      case 'contradiction':
        dispatch({ type: 'CONTRADICTION', contradiction: event.contradiction })
        break
      case 'spec_ready':
        dispatch({ type: 'SPEC_READY', spec: event.spec })
        break
      case 'manifest_ready':
        dispatch({ type: 'MANIFEST_READY', manifest: event.manifest })
        break
      case 'file_generating':
        dispatch({ type: 'FILE_GENERATING', filename: event.filename, fileIndex: event.fileIndex, totalFiles: event.totalFiles })
        break
      case 'token':
        tokenBufferRef.current += event.text
        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(() => {
            dispatch({ type: 'TOKEN', text: tokenBufferRef.current })
            tokenBufferRef.current = ''
            rafRef.current = null
          })
        }
        break
      case 'file_generated':
        dispatch({ type: 'FILE_GENERATED', filename: event.filename, code: event.code })
        break
      case 'review_hunks':
        dispatch({ type: 'REVIEW_HUNKS', actor: event.actor, hunks: event.hunks })
        break
      case 'hunks_merged':
        dispatch({ type: 'HUNKS_MERGED', resolved: event.resolved, conflicts: event.conflicts })
        break
      case 'cross_review_response':
        dispatch({ type: 'CROSS_REVIEW_RESPONSE', actor: event.actor, response: event.response })
        break
      case 'conflicts_resolved':
        dispatch({ type: 'CONFLICTS_RESOLVED', resolved: event.resolved })
        break
      case 'micro_gate':
        dispatch({ type: 'MICRO_GATE', conflict: event.conflict })
        break
      case 'file_patched':
        dispatch({ type: 'FILE_PATCHED', filename: event.filename, code: event.code })
        break
      case 're_review_hunks':
        dispatch({ type: 'RE_REVIEW_HUNKS', actor: event.actor, hunks: event.hunks })
        break
      case 'file_accepted':
        dispatch({ type: 'FILE_ACCEPTED', filename: event.filename, code: event.code })
        break
      case 'arbitration':
        dispatch({ type: 'ARBITRATION', pkg: event.pkg })
        break
      case 'output_gate_ready':
        dispatch({ type: 'OUTPUT_GATE_READY', files: event.files })
        break
      case 'consensus':
        dispatch({ type: 'CONSENSUS', output: event.output })
        break
      case 'github_push_success':
        dispatch({ type: 'GITHUB_PUSH_SUCCESS', sha: event.sha, branch: event.branch, url: event.url })
        break
      case 'github_push_failed':
        dispatch({ type: 'GITHUB_PUSH_FAILED', message: event.message })
        break
    }
  }, [dispatch])

  // ─── Connect / reconnect to SSE stream ────────────────────────────────────

  const connectToStream = useCallback(async (sessionId: string) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    dispatch({ type: 'STREAM_START' })

    try {
      await connectSSE(sessionId, handleSSEEvent, controller.signal)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      dispatch({ type: 'SET_ERROR', message: err instanceof Error ? err.message : 'Stream error' })
      return
    } finally {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        // Flush any remaining buffered tokens
        if (tokenBufferRef.current) {
          dispatch({ type: 'TOKEN', text: tokenBufferRef.current })
          tokenBufferRef.current = ''
        }
        rafRef.current = null
      }
      if (abortRef.current === controller) {
        abortRef.current = null
        dispatch({ type: 'STREAM_END' })
      }
    }

    // If the stream closed at a pipeline-internal phase (not a human gate or
    // terminal state), the pipeline still has work to do — reconnect immediately.
    if (!NO_AUTO_RECONNECT.has(lastPhaseRef.current)) {
      if (reconnectCountRef.current < MAX_AUTO_RECONNECTS) {
        reconnectCountRef.current++
        void connectToStream(sessionId)
      } else {
        dispatch({
          type: 'SET_ERROR',
          message: `Pipeline stalled after ${MAX_AUTO_RECONNECTS} reconnects. Refresh to retry.`,
        })
      }
    } else {
      // Reached a gate — reset reconnect counter
      reconnectCountRef.current = 0
    }
  }, [dispatch, handleSSEEvent])

  // ─── Start pipeline ────────────────────────────────────────────────────────

  const startPipeline = useCallback(async (
    project:         ProjectConfig,
    taskDescription: string,
    contextText?:    string,
  ) => {
    const res = await fetch('/api/pipeline/start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId:      project.id,
        taskDescription,
        coderProvider:  project.coderProvider,
        coderModelId:   project.coderModelId,
        r1Provider:     project.r1Provider,
        r1ModelId:      project.r1ModelId,
        r2Provider:     project.r2Provider,
        r2ModelId:      project.r2ModelId,
        contextText:    contextText || undefined,
      }),
    })

    const data = await res.json() as { success: boolean; data?: { sessionId: string }; error?: string }
    if (!data.success || !data.data) {
      throw new Error(data.error ?? 'Failed to start pipeline')
    }

    const { sessionId } = data.data
    dispatch({ type: 'START_SESSION', sessionId, project })

    // Connect to stream — runs until hitting a gate (questions, spec, etc.)
    void connectToStream(sessionId)
    return sessionId
  }, [dispatch, connectToStream])

  // ─── Submit answers (HUMAN GATE 1) ─────────────────────────────────────────

  const submitAnswers = useCallback(async (answers: Record<string, string>) => {
    if (!state.sessionId) return

    const res = await fetch('/api/pipeline/message', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'answers', sessionId: state.sessionId, answers }),
    })

    const data = await res.json() as { success: boolean; error?: string }
    if (!data.success) throw new Error(data.error ?? 'Failed to submit answers')

    dispatch({ type: 'SET_PHASE', phase: 'phase2_contradiction_check' })
    void connectToStream(state.sessionId)
  }, [state.sessionId, dispatch, connectToStream])

  // ─── Confirm spec + manifest (HUMAN GATE 2) ────────────────────────────────

  const confirmSpec = useCallback(async () => {
    if (!state.sessionId) return

    const res = await fetch('/api/pipeline/message', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'confirm_spec', sessionId: state.sessionId }),
    })

    const data = await res.json() as { success: boolean; error?: string }
    if (!data.success) throw new Error(data.error ?? 'Failed to confirm spec')

    dispatch({ type: 'SET_PHASE', phase: 'phase3_generating' })
    void connectToStream(state.sessionId)
  }, [state.sessionId, dispatch, connectToStream])

  // ─── Micro-gate: R1/R2 disagree on a hunk (HUMAN GATE 3) ───────────────────

  const submitMicroGate = useCallback(async (conflictId: string, choice: 'R1' | 'R2') => {
    if (!state.sessionId) return
    await fetch('/api/pipeline/micro-gate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, conflictId, choice }),
    })
    void connectToStream(state.sessionId)
  }, [state.sessionId, connectToStream])

  // ─── Arbitration: round 3 exhausted (HUMAN GATE 4) ─────────────────────────

  const submitArbitration = useCallback(async (
    filename: string,
    choice:   'r1' | 'r2' | 'accept' | 'regenerate',
    guidance?: string,
  ) => {
    if (!state.sessionId) return
    await fetch('/api/pipeline/arbitration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, filename, choice, guidance }),
    })
    // Arbitration is a mid-pipeline gate, not terminal — the pipeline continues
    // regardless of choice, so the client must always reconnect to see what's next.
    void connectToStream(state.sessionId)
  }, [state.sessionId, connectToStream])

  // ─── Output gate: per-file approval (HUMAN GATE 5) ─────────────────────────

  const acceptOutput = useCallback(async (filename: string) => {
    if (!state.sessionId) return
    await fetch('/api/pipeline/output-gate/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, filename }),
    })
    // output_gate is in NO_AUTO_RECONNECT — the stream closed when the pipeline
    // reached this gate, so the client must reconnect to see the next file (or done).
    void connectToStream(state.sessionId)
  }, [state.sessionId, connectToStream])

  const requestOutputFix = useCallback(async (filename: string, instruction: string) => {
    if (!state.sessionId) throw new Error('No active session')
    return fetch('/api/pipeline/output-gate/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, filename, instruction }),
    }).then(r => r.json())
  }, [state.sessionId])

  // ─── Human override (mid-pipeline interrupt) ───────────────────────────────

  const interrupt = useCallback(async (message: string) => {
    if (!state.sessionId) return
    await fetch('/api/pipeline/interrupt', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, message }),
    })
  }, [state.sessionId])

  // ─── Pause ────────────────────────────────────────────────────────────────

  const pause = useCallback(() => {
    if (!state.sessionId) return
    abortRef.current?.abort()
    dispatch({ type: 'SET_PHASE', phase: 'paused' })
    fetch('/api/pipeline/pause', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId }),
    }).catch(() => {})
  }, [state.sessionId, dispatch])

  // ─── Play ─────────────────────────────────────────────────────────────────

  const play = useCallback(async () => {
    if (!state.sessionId) return
    const res = await fetch('/api/pipeline/play', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId }),
    })
    const data = await res.json() as { success: boolean; error?: string }
    if (!data.success) return
    void connectToStream(state.sessionId)
  }, [state.sessionId, connectToStream])

  // ─── Stop ─────────────────────────────────────────────────────────────────

  const stop = useCallback(() => {
    if (!state.sessionId) return
    abortRef.current?.abort()
    dispatch({ type: 'SET_PHASE', phase: 'stopped' })
    fetch('/api/pipeline/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId }),
    }).catch(() => {})
  }, [state.sessionId, dispatch])

  // ─── Budget refresh ────────────────────────────────────────────────────────

  const refreshBudget = useCallback(async () => {
    try {
      const url = `/api/budget${state.sessionId ? `?sessionId=${state.sessionId}` : ''}`
      const res  = await fetch(url)
      if (res.ok) {
        const data = await res.json() as { success: boolean; data?: BudgetStatus }
        if (data.success && data.data) dispatch({ type: 'BUDGET_UPDATE', budget: data.data })
      }
    } catch {
      // Budget refresh is non-fatal — silently ignore network errors
    }
  }, [state.sessionId, dispatch])

  return {
    startPipeline,
    submitAnswers,
    confirmSpec,
    submitMicroGate,
    submitArbitration,
    acceptOutput,
    requestOutputFix,
    interrupt,
    pause,
    play,
    stop,
    refreshBudget,
    // answer individual questions (used by QuestionsPanel)
    answerQuestion: (questionId: string, answer: string) =>
      dispatch({ type: 'SET_ANSWER', questionId, answer }),
    resetSession: () => {
      lastPhaseRef.current = 'idle'
      reconnectCountRef.current = 0
      dispatch({ type: 'RESET_SESSION' })
    },
  }
}
