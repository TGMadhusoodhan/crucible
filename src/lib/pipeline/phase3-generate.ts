import { appendSessionLog } from '@/lib/memory/session-log'
import type { FileManifest, ModelAdapter, RegistryEntry, SpecDocument, SSEEvent } from '@/types'

export async function runPhase3Generate(
  projectId:          string,
  sessionId:          string,
  filename:           string,
  fileIndex:          number,
  totalFiles:         number,
  manifest:           FileManifest,
  spec:               SpecDocument,
  coderAdapter:       ModelAdapter,
  generatedSoFar:     Record<string, string>,
  emit:               (e: SSEEvent) => void,
  contextText?:       string,
  regenerationHint?:  string,
  registry?:          RegistryEntry[],
): Promise<{ code: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; cacheWriteTokens: number }> {
  emit({ type: 'phase_change', phase: 'phase3_generating' })
  emit({ type: 'file_generating', filename, fileIndex, totalFiles })

  const fileDef = manifest.files.find(f => f.filename === filename)
  if (!fileDef) throw new Error(`File "${filename}" not found in manifest`)

  const result = await coderAdapter.generate(
    filename, fileDef, manifest, spec, generatedSoFar, contextText,
    (token) => emit({ type: 'token', text: token }),
    regenerationHint,
    registry,
  )

  emit({ type: 'file_generated', filename, code: result.code })
  await appendSessionLog(projectId, sessionId, {
    phase: 'phase3_generating', actor: 'coder',
    summary: `Generated ${filename}`,
  })
  return result
}
