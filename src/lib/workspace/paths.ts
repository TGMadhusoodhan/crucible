import path from 'path'

/**
 * Resolves `relPath` relative to `workspaceDir` and verifies it stays inside
 * the workspace. Throws on null bytes or path traversal attempts.
 *
 * Every filesystem write and read in workspace code MUST go through this
 * function — manifest filenames come from model output and are untrusted.
 */
export function resolveInWorkspace(workspaceDir: string, relPath: string): string {
  if (relPath.includes('\0')) {
    throw new Error('Invalid path: null bytes are not allowed')
  }

  const resolved = path.resolve(workspaceDir, relPath)
  const relative = path.relative(workspaceDir, resolved)

  // A safe path must be relative, non-empty (not the root itself), and not start with '..'
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path traversal rejected: "${relPath}" escapes the workspace`)
  }

  return resolved
}
