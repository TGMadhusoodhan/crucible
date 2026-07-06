import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'
import { resolveInWorkspace } from './paths'

const execFileAsync = promisify(execFile)

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.crucible'])

// ─── Git helpers ──────────────────────────────────────────────────────────────

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd })
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ['rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

async function hasDirtyState(dir: string): Promise<boolean> {
  const { stdout } = await git(dir, ['status', '--porcelain'])
  return stdout.trim().length > 0
}

// ─── Workspace setup ──────────────────────────────────────────────────────────

/**
 * Called before each pipeline session that will write to a workspace.
 * Initializes git if absent; commits any user edits as a snapshot so nothing
 * is lost if Crucible overwrites files.
 *
 * Never blocks the pipeline — logs a warning if git is unavailable.
 */
export async function prepareWorkspaceForSession(workspaceDir: string): Promise<void> {
  try {
    if (!(await isGitRepo(workspaceDir))) {
      await git(workspaceDir, ['init'])
      const gitignorePath = path.join(workspaceDir, '.gitignore')
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(
          gitignorePath,
          ['node_modules/', '.next/', 'dist/', '.env', '.env.*', '*.log'].join('\n') + '\n',
        )
      }
      await git(workspaceDir, ['add', '-A'])
      await git(workspaceDir, ['commit', '--allow-empty', '-m', 'crucible: initialize workspace'])
      return
    }

    if (await hasDirtyState(workspaceDir)) {
      await git(workspaceDir, ['add', '-A'])
      await git(workspaceDir, ['commit', '-m', 'crucible: pre-session snapshot'])
    }
  } catch (err) {
    console.warn('[workspace] git unavailable, skipping pre-session snapshot:', err instanceof Error ? err.message : err)
  }
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

/**
 * Writes `code` to `<workspaceDir>/<filename>`, creating parent dirs as needed,
 * then commits the file with a message linking it to the session + round.
 *
 * Returns the short commit hash on success, null if git is unavailable or fails.
 * Never throws — the write always succeeds; git failure is non-fatal.
 */
export async function writeAcceptedFile(
  workspaceDir: string,
  filename:     string,
  code:         string,
  sessionId:    string,
  round:        number,
): Promise<string | null> {
  const destPath = resolveInWorkspace(workspaceDir, filename)
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.writeFileSync(destPath, code)

  try {
    await git(workspaceDir, ['add', filename])
    await git(workspaceDir, ['commit', '-m',
      `crucible: accept ${filename} (session ${sessionId.slice(0, 8)}, round ${round})`])
    const { stdout } = await git(workspaceDir, ['log', '-1', '--format=%h', '--', filename])
    return stdout.trim() || null
  } catch {
    return null
  }
}

export function readWorkspaceFile(workspaceDir: string, filename: string): string {
  const filePath = resolveInWorkspace(workspaceDir, filename)
  if (!fs.existsSync(filePath)) throw new Error(`File not found in workspace: ${filename}`)
  return fs.readFileSync(filePath, 'utf8')
}

export function listWorkspaceFiles(workspaceDir: string): string[] {
  if (!fs.existsSync(workspaceDir)) return []
  return readdirRecursive(workspaceDir, workspaceDir)
}

function readdirRecursive(baseDir: string, dir: string): string[] {
  const results: string[] = []
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...readdirRecursive(baseDir, full))
      } else {
        results.push(path.relative(baseDir, full))
      }
    }
  } catch { /* skip unreadable entries */ }
  return results
}

/**
 * Returns the short git commit hash for the most recent commit touching `filename`,
 * or null if git is unavailable or the file has no history.
 */
export async function getFileCommitHash(workspaceDir: string, filename: string): Promise<string | null> {
  try {
    const { stdout } = await git(workspaceDir, ['log', '-1', '--format=%h', '--', filename])
    return stdout.trim() || null
  } catch {
    return null
  }
}
