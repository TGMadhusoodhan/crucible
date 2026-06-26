import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { readOutputFile, writeOutput } from '@/lib/memory/filesystem'
import { getSessionState } from '@/lib/pipeline/orchestrator'
import { getAdapter } from '@/lib/adapters'
import type { ApiResponse, PipelineContext } from '@/types'

const postSchema = z.object({
  prompt:    z.string().min(1).max(4000),
  sessionId: z.string().optional(),
})

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; filepath: string[] }> },
): Promise<NextResponse<ApiResponse<{ content: string }>>> {
  try {
    const { projectId, filepath } = await params
    const filename = filepath.join('/')
    const content  = readOutputFile(projectId, filename)
    return NextResponse.json({ success: true, data: { content } })
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : 'Not found' }, { status: 404 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; filepath: string[] }> },
): Promise<NextResponse<ApiResponse<{ content: string }>>> {
  try {
    const { projectId, filepath } = await params
    const filename = filepath.join('/')

    const parsed = postSchema.safeParse(await request.json() as unknown)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      )
    }

    const { prompt, sessionId } = parsed.data

    // Read current file content
    let currentCode = ''
    try { currentCode = readOutputFile(projectId, filename) } catch { /* new file */ }

    // Resolve model config from session or use a default
    let config: { provider: string; modelId: string; apiKey: string } | null = null
    if (sessionId) {
      const state = await getSessionState(sessionId)
      if (state) {
        config = {
          provider: state.config.primaryProvider,
          modelId:  state.config.primaryModelId,
          apiKey:   state.config.primaryApiKey,
        }
      }
    }

    if (!config) {
      return NextResponse.json({ success: false, error: 'Session required to modify files' }, { status: 400 })
    }

    const adapter = getAdapter(config.provider as Parameters<typeof getAdapter>[0], config.modelId, config.apiKey)

    const generationPrompt = [
      `FILE: ${filename}`,
      '',
      'USER REQUEST:',
      prompt,
      '',
      currentCode ? 'CURRENT CODE (modify to satisfy the request):' : 'This is a new file — create it based on the request.',
      currentCode ? '```' : '',
      currentCode,
      currentCode ? '```' : '',
      '',
      'Return ONLY the updated code. No preamble, no explanation.',
    ].filter(l => l !== '' || currentCode).join('\n')

    // Stream generation into a string
    let newCode = ''
    const ctx: PipelineContext = {
      projectId,
      sessionId: sessionId ?? '',
      spec: {
        id: '', project_id: projectId, session_id: sessionId ?? '',
        created_at: new Date().toISOString(),
        task_description: prompt,
        user_decisions: {}, model_defaults: {},
        acceptance_criteria: [], edge_cases: [], error_messages: [],
        human_confirmed: true,
      },
      history:   [],
      activeMemory: { current_module: filename, open_questions: [], file_structure: {}, recent_decisions: [], current_tech_stack: [], unresolved_conflicts: [] },
      humanOverrides:  [],
      taskDescription: prompt,
    }

    for await (const token of adapter.generate(generationPrompt, ctx)) {
      newCode += token
    }

    // Write updated file to disk
    writeOutput(projectId, filename, newCode)

    return NextResponse.json({ success: true, data: { content: newCode } })
  } catch (err) {
    console.error('POST /api/files:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 })
  }
}
