import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSessionState, saveSessionState } from '@/lib/pipeline/orchestrator'
import { getAdapter } from '@/lib/adapters'
import { parseMultiFileOutput } from '@/lib/pipeline/phase3-generate'
import type { ApiResponse, PipelineContext } from '@/types'

const schema = z.object({
  sessionId:    z.string().min(1),
  filename:     z.string().min(1),
  code:         z.string(),
  feedback:     z.string().min(1).max(4000),
  // Optional model override — must be 'primary' or 'reviewer'
  modelRole:    z.enum(['primary', 'reviewer']).optional(),
})

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<{ code: string; modelId: string }>>> {
  try {
    const parsed = schema.safeParse(await request.json() as unknown)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      )
    }

    const { sessionId, filename, code, feedback, modelRole = 'primary' } = parsed.data
    const state = await getSessionState(sessionId)
    if (!state) return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 })

    if (state.phase !== 'phase3_file_gate') {
      return NextResponse.json(
        { success: false, error: `Not at file gate (current: ${state.phase})` },
        { status: 409 },
      )
    }

    const { config } = state
    const useReviewer = modelRole === 'reviewer'
    const provider    = useReviewer ? config.reviewerProvider  : config.primaryProvider
    const modelId     = useReviewer ? config.reviewerModelId   : config.primaryModelId
    const apiKey      = useReviewer ? config.reviewerApiKey    : config.primaryApiKey

    const adapter = getAdapter(provider, modelId, apiKey)

    const prompt = [
      'HUMAN FEEDBACK MODE — update this single file based on the user\'s request.',
      '',
      `FILE: ${filename}`,
      '',
      'USER REQUEST:',
      feedback,
      '',
      'CURRENT CODE (modify to satisfy the request; preserve everything the request does not touch):',
      '```',
      code,
      '```',
      '',
      'Return ONLY the updated code for this file. No preamble, no explanation.',
    ].join('\n')

    const ctx: PipelineContext = {
      projectId:       state.projectId,
      sessionId:       state.sessionId,
      spec:            state.spec!,
      history:         state.conversationHistory.slice(-10),
      activeMemory:    {
        current_module:       state.taskDescription.slice(0, 80),
        open_questions:       [],
        file_structure:       {},
        recent_decisions:     [],
        current_tech_stack:   [],
        unresolved_conflicts: [],
      },
      humanOverrides:  [],
      taskDescription: state.taskDescription,
    }

    // Accumulate with a per-token idle timeout — mirrors the protection in phase3-generate.ts.
    // Without this, a stalled model holds the HTTP connection open indefinitely.
    const INTER_TOKEN_TIMEOUT_MS = 90_000
    const stream = adapter.generate(prompt, ctx)
    let newCode = ''
    let first = true
    try {
      while (true) {
        const result = await new Promise<IteratorResult<string>>((resolve, reject) => {
          const ms    = first ? 300_000 : INTER_TOKEN_TIMEOUT_MS
          const timer = setTimeout(
            () => reject(new Error(`Model stalled after ${ms / 1000}s — try again`)),
            ms,
          )
          stream.next().then(
            r => { clearTimeout(timer); resolve(r) },
            e => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))) },
          )
        })
        if (result.done) break
        first = false
        newCode += result.value
      }
    } catch (err) {
      try { await stream.return?.(undefined) } catch { /* best-effort cleanup */ }
      throw new Error(`Generation failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Strip accidental FILE delimiters if the model wrapped its output
    const parsed2  = parseMultiFileOutput(newCode)
    const firstKey = Object.keys(parsed2)[0]
    const cleanCode = firstKey ? (parsed2[firstKey] ?? newCode) : newCode

    // Update the file in session state so when accepted it goes to disk correctly
    if (state.generatedFiles) state.generatedFiles[filename] = cleanCode
    await saveSessionState(state)

    return NextResponse.json({ success: true, data: { code: cleanCode, modelId } })
  } catch (err) {
    console.error('POST /api/pipeline/file-feedback:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 })
  }
}
