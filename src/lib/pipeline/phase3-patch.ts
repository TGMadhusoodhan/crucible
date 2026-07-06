import { appendSessionLog } from '@/lib/memory/session-log'
import { applyResolvedHunks } from '@/lib/utils/hunk-merge'
import type { ModelAdapter, ResolvedHunk, SSEEvent } from '@/types'

// Sanity check on the model's "reproduce the whole file" output. It can't
// require an exact line count (patches change line counts), but a wildly
// different count than expected means the model truncated, dropped, or
// rewrote the file — asking a model to reproduce a large file verbatim
// except for a few lines risks exactly that. Falls back to the deterministic
// applyResolvedHunks (byte-exact for the non-overlapping case) when it does.
function isPlausiblePatch(originalCode: string, patchedCode: string, hunks: ResolvedHunk[]): boolean {
  if (!patchedCode.trim()) return false
  const originalLines = originalCode.split('\n').length
  const netLineDelta = hunks.reduce(
    (sum, h) => sum + (h.new_code.split('\n').length - (h.line_end - h.line_start + 1)),
    0,
  )
  const expectedLines = originalLines + netLineDelta
  const patchedLines  = patchedCode.split('\n').length
  return Math.abs(patchedLines - expectedLines) <= Math.max(10, expectedLines * 0.2)
}

export async function runPhase3Patch(
  projectId:     string,
  sessionId:     string,
  filename:      string,
  originalCode:  string,
  hunks:         ResolvedHunk[],
  coderAdapter:  ModelAdapter,
  emit:          (e: SSEEvent) => void,
): Promise<string> {
  emit({ type: 'phase_change', phase: 'phase3_patching' })

  const fileHunks = hunks.filter(h => h.filename === filename)
  if (fileHunks.length === 0) {
    emit({ type: 'file_patched', filename, code: originalCode })
    return originalCode
  }

  // DeepSeek applies the EXACT reviewer-decided code to the right locations.
  // It does NOT modify, improve, or judge — purely mechanical application.
  const { code: modelPatchedCode } = await coderAdapter.applyPatch(
    filename, originalCode, fileHunks, () => {},
  )

  const patchedCode = isPlausiblePatch(originalCode, modelPatchedCode, fileHunks)
    ? modelPatchedCode
    : applyResolvedHunks(originalCode, fileHunks)

  emit({ type: 'file_patched', filename, code: patchedCode })
  await appendSessionLog(projectId, sessionId, {
    phase: 'phase3_patching', actor: 'coder',
    summary: `Applied ${fileHunks.length} patches to ${filename}`,
  })
  return patchedCode
}
