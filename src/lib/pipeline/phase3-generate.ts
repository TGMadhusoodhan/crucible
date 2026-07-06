import { appendSessionLog } from '@/lib/memory/session-log'
import type { FileManifest, ModelAdapter, SpecDocument, SSEEvent } from '@/types'

export async function runPhase3Generate(
  projectId:      string,
  sessionId:      string,
  filename:       string,
  fileIndex:      number,
  totalFiles:     number,
  manifest:       FileManifest,
  spec:           SpecDocument,
  coderAdapter:   ModelAdapter,
  generatedSoFar: Record<string, string>,
  emit:           (e: SSEEvent) => void,
  contextText?:   string,
): Promise<string> {
  emit({ type: 'phase_change', phase: 'phase3_generating' })
  emit({ type: 'file_generating', filename, fileIndex, totalFiles })

  const fileDef = manifest.files.find(f => f.filename === filename)
  if (!fileDef) throw new Error(`File "${filename}" not found in manifest`)

  const { code: generated } = await coderAdapter.generate(
    filename, fileDef, manifest, spec, generatedSoFar, contextText,
    (token) => emit({ type: 'token', text: token }),
  )

  emit({ type: 'file_generated', filename, code: generated })
  await appendSessionLog(projectId, sessionId, {
    phase: 'phase3_generating', actor: 'coder',
    summary: `Generated ${filename}`,
  })
  return generated
}
