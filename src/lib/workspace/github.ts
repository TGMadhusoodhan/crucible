import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// ─── Token scrubbing ──────────────────────────────────────────────────────────

export function scrubToken(text: string, token: string): string {
  if (!token) return text
  // Escape the token for use in a regex (handles special regex chars in tokens)
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(escaped, 'g'), '[REDACTED]')
}

// ─── GitHub REST helpers ──────────────────────────────────────────────────────

export interface GitHubUser {
  login: string
}

export async function fetchGitHubUser(token: string): Promise<GitHubUser> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub auth failed (${res.status}): ${body.slice(0, 200)}`)
  }
  const data = await res.json() as { login?: string }
  if (!data.login) throw new Error('GitHub user response missing login field')
  return { login: data.login }
}

export async function checkRepoWriteAccess(owner: string, repo: string, token: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 404) throw new Error(`Repository ${owner}/${repo} not found or not accessible`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub repo check failed (${res.status}): ${body.slice(0, 200)}`)
  }
  const data = await res.json() as { permissions?: { push?: boolean } }
  if (data.permissions && data.permissions.push === false) {
    throw new Error(`No write access to ${owner}/${repo} — token needs Contents: Read and write`)
  }
}

export async function createGitHubRepo(name: string, token: string): Promise<string> {
  const res = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, private: true, auto_init: false }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Failed to create GitHub repo (${res.status}): ${body.slice(0, 200)}`)
  }
  const data = await res.json() as { full_name?: string }
  if (!data.full_name) throw new Error('GitHub create-repo response missing full_name')
  return data.full_name
}

// ─── Git push with ephemeral token URL ────────────────────────────────────────
// The token URL (https://x-access-token:<token>@github.com/…) is passed
// DIRECTLY to git push as the remote argument — it is NEVER written to
// .git/config or any file. Error messages are scrubbed before propagation.

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME:     'Crucible',
  GIT_AUTHOR_EMAIL:    'crucible@localhost',
  GIT_COMMITTER_NAME:  'Crucible',
  GIT_COMMITTER_EMAIL: 'crucible@localhost',
}

async function git(cwd: string, args: string[], token: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', args, { cwd, timeout: 30_000, env: GIT_ENV })
  } catch (err: unknown) {
    // Scrub token from error before re-throwing
    const msg  = err instanceof Error ? err.message  : String(err)
    const scrubbed = scrubToken(msg, token)
    throw new Error(scrubbed)
  }
}

async function getHeadSha(workspaceDir: string, token: string): Promise<string> {
  const { stdout } = await git(workspaceDir, ['rev-parse', 'HEAD'], token)
  return stdout.trim()
}

async function remoteBranchExists(workspaceDir: string, tokenUrl: string, branch: string, token: string): Promise<boolean> {
  try {
    const { stdout } = await git(workspaceDir, ['ls-remote', '--heads', tokenUrl, `refs/heads/${branch}`], token)
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function isRepoEmpty(workspaceDir: string, tokenUrl: string, token: string): Promise<boolean> {
  try {
    const { stdout } = await git(workspaceDir, ['ls-remote', '--heads', tokenUrl], token)
    return stdout.trim().length === 0
  } catch {
    return true
  }
}

export interface PushResult {
  sha:    string
  branch: string
  url:    string    // https://github.com/owner/repo/commit/<sha>
}

/**
 * Push the workspace git history to GitHub.
 *
 * Security: token is passed only as a direct argument to git push — never
 * written to .git/config, never logged, never included in error messages.
 *
 * Refuses force-push: if the remote has diverged it reports the error and
 * lets the caller decide. The pipeline must treat this as non-fatal.
 */
export async function pushWorkspace(
  workspaceDir: string,
  githubRepo:   string,       // "owner/name"
  githubBranch: string,
  token:        string,
): Promise<PushResult> {
  const tokenUrl = `https://x-access-token:${token}@github.com/${githubRepo}.git`
  const cleanUrl  = `https://github.com/${githubRepo}.git`

  const sha = await getHeadSha(workspaceDir, token)

  // First push of a brand-new empty repo: add a README stub
  const empty = await isRepoEmpty(workspaceDir, tokenUrl, token)
  if (empty) {
    const fs = await import('fs')
    const path = await import('path')
    const readmePath = path.join(workspaceDir, 'README.md')
    if (!fs.existsSync(readmePath)) {
      const [owner, name] = githubRepo.split('/')
      const content = [
        `# ${name ?? githubRepo}`,
        '',
        'Generated by [Crucible](https://github.com) — multi-LLM coding orchestration.',
        `Owner: ${owner}`,
      ].join('\n') + '\n'
      fs.writeFileSync(readmePath, content)
      await git(workspaceDir, ['add', '--', 'README.md'], token)
      await git(workspaceDir, ['commit', '-m', 'crucible: add README'], token)
    }
  }

  // Push HEAD to the target branch
  const pushRef = `HEAD:refs/heads/${githubBranch}`
  const { stderr } = await git(workspaceDir, ['push', tokenUrl, pushRef], token)

  if (stderr.toLowerCase().includes('rejected') && stderr.includes('non-fast-forward')) {
    throw new Error(
      `Push rejected: remote branch '${githubBranch}' has diverged from local. ` +
      `Pull and merge remote changes before pushing. (${cleanUrl})`,
    )
  }

  const finalSha = await getHeadSha(workspaceDir, token)

  return {
    sha:    finalSha,
    branch: githubBranch,
    url:    `https://github.com/${githubRepo}/commit/${finalSha}`,
  }
}
