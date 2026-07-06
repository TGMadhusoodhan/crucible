import { appendSessionLog } from '@/lib/memory/session-log'
import { applyResolvedHunks } from '@/lib/utils/hunk-merge'
import type { ModelAdapter, ResolvedHunk, SSEEvent } from '@/types'

export async function runPhase3Patch(
  projectId:    string,
  sessionId:    string,
  filename:     string,
  originalCode: string,
  hunks:        ResolvedHunk[],
  coderAdapter: ModelAdapter,
  emit:         (e: SSEEvent) => void,
): Promise<string> {
  emit({ type: 'phase_change', phase: 'phase3_patching' })

  const fileHunks = hunks.filter(h => h.filename === filename)
  if (fileHunks.length === 0) {
    emit({ type: 'file_patched', filename, code: originalCode })
    return originalCode
  }

  // Primary path: deterministic anchor-based string replacement.
  // No model call, no truncation risk, no hallucination.
  const { code: primaryPatched, failedHunks } = applyResolvedHunks(originalCode, fileHunks)

  let finalCode = primaryPatched

  // Fallback: only for hunks whose original_code anchor could not be located.
  // One model call covers all failed hunks at once, applied to the already-patched file.
  if (failedHunks.length > 0) {
    console.warn(`[phase3-patch] ${failedHunks.length} hunk(s) failed anchor-locate for ${filename} — using model fallback`)
    try {
      const { code: modelFixed } = await coderAdapter.applyPatch(
        filename, primaryPatched, failedHunks, () => {},
      )
      if (modelFixed.trim()) finalCode = modelFixed
    } catch (err) {
      console.error(`[phase3-patch] model fallback failed for ${filename}:`, err)
      // Keep primaryPatched — at least the successfully-applied hunks are in
    }
  }

  emit({ type: 'file_patched', filename, code: finalCode })
  await appendSessionLog(projectId, sessionId, {
    phase: 'phase3_patching', actor: 'coder',
    summary: `Applied ${fileHunks.length - failedHunks.length}/${fileHunks.length} patches to ${filename}`
           + (failedHunks.length > 0 ? ` (${failedHunks.length} via model fallback)` : ''),
  })
  return finalCode
}
