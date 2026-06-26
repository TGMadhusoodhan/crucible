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
  'phase2_spec_confirm',
  'phase3_file_gate',
  'phase3_file_feedback',
  'conflict_escalated',
  'paused',
  'stopped',
  'complete',
  'error',
])

// Phases that are internal pipeline phases (not human gates).
// When stream closes at these, client reconnects automatically.
// phase3_reviewing, phase3_reviewer_edit, phase3_coder_verify, phase3_dialogue
// are all pipeline-internal phases handled within one stream session or auto-reconnected.

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
      case 'thinking_done':
        dispatch({ type: 'THINKING_DONE', actor: event.actor, output: event.output })
        break
      case 'alignment_msg':
        dispatch({ type: 'ALIGNMENT_MSG', message: event.message })
        break
      case 'questions_ready':
        dispatch({ type: 'QUESTIONS_READY', questions: event.questions })
        dispatch({ type: 'SET_PHASE', phase: 'phase2_answering' })
        break
      case 'contradiction':
        dispatch({ type: 'SET_CONTRADICTION', contradiction: event.contradiction })
        break
      case 'spec_ready':
        dispatch({ type: 'SPEC_READY', spec: event.spec })
        dispatch({ type: 'SET_PHASE', phase: 'phase2_spec_confirm' })
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
      case 'self_check_done':
        dispatch({ type: 'SELF_CHECK_DONE', output: event.output })
        break
      case 'review_done':
        dispatch({ type: 'REVIEW_DONE', review: event.review })
        break
      case 'consensus':
        dispatch({ type: 'CONSENSUS', output: event.output })
        break
      case 'file_ready':
        dispatch({ type: 'FILE_READY', filename: event.filename, code: event.code, fileIndex: event.fileIndex, totalFiles: event.totalFiles })
        break
      case 'file_accepted':
        dispatch({ type: 'FILE_ACCEPTED', filename: event.filename, code: event.code, fileIndex: event.fileIndex })
        break
      case 'files_complete':
        dispatch({ type: 'FILES_COMPLETE', acceptedFiles: event.acceptedFiles })
        break
      case 'conflict': {
        const review = event.review
        const highMed = review.flags
          .filter(f => f.severity !== 'LOW')
          .map(f => `[${f.severity}] ${f.description}`)
          .join('\n')
        dispatch({
          type:   'CONFLICT_ESCALATED',
          review,
          round:  event.round,
          reason: highMed || review.reasoning,
        })
        break
      }
      case 'reviewer_edit_done':
        dispatch({ type: 'REVIEWER_EDIT_DONE', edit: event.edit })
        break
      case 'coder_verify_done':
        dispatch({ type: 'CODER_VERIFY_DONE', verification: event.verification })
        break
      case 'dialogue_msg':
        dispatch({ type: 'DIALOGUE_MSG', message: event.message })
        break
      case 'dialogue_resolved':
        dispatch({ type: 'DIALOGUE_RESOLVED', mergedCode: event.mergedCode })
        break
      case 'dialogue_escalated':
        dispatch({ type: 'DIALOGUE_ESCALATED', summary: event.summary })
        break
      case 'error':
        dispatch({ type: 'SET_ERROR', error: event.message })
        dispatch({ type: 'SET_PHASE', phase: 'error' })
        break
      case 'done':
        dispatch({ type: 'SET_STREAMING', value: false })
        break
    }
  }, [dispatch])

  // ─── Connect / reconnect to SSE stream ────────────────────────────────────

  const connectToStream = useCallback(async (sessionId: string) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    dispatch({ type: 'SET_STREAMING', value: true })

    try {
      await connectSSE(sessionId, handleSSEEvent, controller.signal)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Stream error' })
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
        dispatch({ type: 'SET_STREAMING', value: false })
      }
    }

    // If the stream closed at a pipeline-internal phase (not a human gate or
    // terminal state), the pipeline still has work to do — reconnect immediately.
    // This handles the normal split (phase3_reviewing), Vercel timeout mid-self-check
    // (phase3_self_check), and any other unexpected mid-pipeline disconnect.
    if (!NO_AUTO_RECONNECT.has(lastPhaseRef.current)) {
      if (reconnectCountRef.current < MAX_AUTO_RECONNECTS) {
        reconnectCountRef.current++
        void connectToStream(sessionId)
      } else {
        dispatch({
          type: 'SET_ERROR',
          error: `Pipeline stalled after ${MAX_AUTO_RECONNECTS} reconnects. Refresh to retry.`,
        })
      }
    } else {
      // Reached a gate — reset reconnect counter
      reconnectCountRef.current = 0
    }
  }, [dispatch, handleSSEEvent])

  // ─── Start pipeline ────────────────────────────────────────────────────────

  const startPipeline = useCallback(async (
    taskDescription: string,
    contextText?:    string,
  ) => {
    if (!state.project) throw new Error('No project selected')

    const res = await fetch('/api/pipeline/start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId:        state.project.id,
        taskDescription,
        primaryProvider:  state.project.primaryProvider,
        primaryModelId:   state.project.primaryModelId,
        reviewerProvider: state.project.reviewerProvider,
        reviewerModelId:  state.project.reviewerModelId,
        contextText:      contextText || undefined,
      }),
    })

    const data = await res.json() as { success: boolean; data?: { sessionId: string }; error?: string }
    if (!data.success || !data.data) {
      throw new Error(data.error ?? 'Failed to start pipeline')
    }

    const { sessionId } = data.data
    dispatch({ type: 'START_SESSION', sessionId })

    // Connect to stream — runs until hitting a gate (questions, spec, etc.)
    void connectToStream(sessionId)
    return sessionId
  }, [state.project, dispatch, connectToStream])

  // ─── Submit answers ────────────────────────────────────────────────────────

  const submitAnswers = useCallback(async (answers: Record<string, string>) => {
    if (!state.sessionId) return

    const res = await fetch('/api/pipeline/message', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'answers', sessionId: state.sessionId, answers }),
    })

    const data = await res.json() as { success: boolean; error?: string }
    if (!data.success) throw new Error(data.error ?? 'Failed to submit answers')

    dispatch({ type: 'SET_PHASE', phase: 'phase2_contradictions' })
    void connectToStream(state.sessionId)
  }, [state.sessionId, dispatch, connectToStream])

  // ─── Confirm spec ──────────────────────────────────────────────────────────

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
    // streamingCode is reset in the reducer when phase becomes 'phase3_generating'
    void connectToStream(state.sessionId)
  }, [state.sessionId, dispatch, connectToStream])

  // ─── Resolve conflict ──────────────────────────────────────────────────────

  const resolveConflict = useCallback(async (overrideMessage: string) => {
    if (!state.sessionId) return

    const res = await fetch('/api/pipeline/resolve', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, overrideMessage }),
    })

    const data = await res.json() as { success: boolean; error?: string }
    if (!data.success) throw new Error(data.error ?? 'Failed to resolve conflict')

    dispatch({ type: 'SET_PHASE', phase: 'phase3_generating' })
    void connectToStream(state.sessionId)
  }, [state.sessionId, dispatch, connectToStream])

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

  // ─── File gate: accept current file ──────────────────────────────────────

  const acceptFile = useCallback(async (filename: string, code: string) => {
    if (!state.sessionId) return

    const res = await fetch('/api/pipeline/file-accept', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, filename, code }),
    })

    const data = await res.json() as { success: boolean; data?: { fileIndex: number; done: boolean }; error?: string }
    if (!data.success) throw new Error(data.error ?? 'Failed to accept file')

    // Use server-returned fileIndex as the source of truth to avoid
    // off-by-one if the user somehow triggers acceptFile twice.
    dispatch({ type: 'FILE_ACCEPTED', filename, code, fileIndex: (data.data?.fileIndex ?? state.currentFileIndex + 1) - 1 })

    if (data.data?.done) {
      // All files accepted — reconnect to get files_complete event
      dispatch({ type: 'FILES_COMPLETE', acceptedFiles: { ...state.acceptedFiles, [filename]: code } })
    } else {
      // More files remain — reconnect to get file_ready for next file
      void connectToStream(state.sessionId)
    }
  }, [state.sessionId, state.currentFileIndex, state.acceptedFiles, dispatch, connectToStream])

  // ─── File gate: send feedback for current file ────────────────────────────

  const submitFileFeedback = useCallback(async (
    filename:  string,
    code:      string,
    feedback:  string,
    modelRole: 'primary' | 'reviewer' = 'primary',
  ): Promise<{ code: string; modelId: string }> => {
    if (!state.sessionId) throw new Error('No active session')

    const res = await fetch('/api/pipeline/file-feedback', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, filename, code, feedback, modelRole }),
    })

    const data = await res.json() as { success: boolean; data?: { code: string; modelId: string }; error?: string }
    if (!data.success || !data.data) throw new Error(data.error ?? 'Failed to get file feedback')

    dispatch({ type: 'FILE_FEEDBACK', filename, code: data.data.code })
    return data.data
  }, [state.sessionId, dispatch])

  // ─── Budget refresh ────────────────────────────────────────────────────────

  const refreshBudget = useCallback(async () => {
    try {
      const url = `/api/budget${state.sessionId ? `?sessionId=${state.sessionId}` : ''}`
      const res  = await fetch(url)
      if (res.ok) {
        const data = await res.json() as { success: boolean; data?: BudgetStatus }
        if (data.success && data.data) dispatch({ type: 'SET_BUDGET', budget: data.data })
      }
    } catch {
      // Budget refresh is non-fatal — silently ignore network errors
    }
  }, [state.sessionId, dispatch])

  return {
    startPipeline,
    submitAnswers,
    confirmSpec,
    resolveConflict,
    interrupt,
    pause,
    play,
    stop,
    refreshBudget,
    // answer individual questions (used by QuestionsPanel)
    answerQuestion: (questionId: string, optionId: string) =>
      dispatch({ type: 'ANSWER_QUESTION', questionId, optionId }),
    setProject: (project: ProjectConfig) =>
      dispatch({ type: 'SET_PROJECT', project }),
    acceptFile,
    submitFileFeedback,
    resetSession: () => {
      lastPhaseRef.current = 'idle'
      reconnectCountRef.current = 0
      dispatch({ type: 'RESET_SESSION' })
    },
  }
}
