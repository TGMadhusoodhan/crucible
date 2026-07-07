import { NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { isRunningInDocker } from '@/lib/adapters/cli-local'
import type { ApiResponse } from '@/types'

const execFileAsync = promisify(execFile)

interface CliBackendStatus {
  available: boolean
  version?:  string
  loggedIn?: boolean
  reason?:   string
}

interface CliStatusData {
  inDocker:  boolean
  claudeCode: CliBackendStatus
  codex:      CliBackendStatus
}

async function checkClaude(): Promise<CliBackendStatus> {
  // Check binary is present
  let version: string
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 8_000 })
    version = stdout.trim().split('\n')[0] ?? ''
  } catch {
    return { available: false, reason: 'claude CLI not found — install Claude Code from claude.ai/download' }
  }

  // Check auth: a very cheap non-interactive call
  try {
    await execFileAsync(
      'claude',
      ['-p', 'ping', '--output-format', 'json', '--allowedTools', ''],
      { timeout: 15_000 },
    )
    return { available: true, version, loggedIn: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // "not logged in" or auth errors come back via stderr / non-zero exit
    const lower = msg.toLowerCase()
    if (lower.includes('login') || lower.includes('auth') || lower.includes('oauth')) {
      return { available: true, version, loggedIn: false, reason: 'Not logged in — run: claude login' }
    }
    // Any other error: binary present but status unknown
    return { available: true, version, loggedIn: false, reason: msg.slice(0, 120) }
  }
}

async function checkCodex(): Promise<CliBackendStatus> {
  let version: string
  try {
    const { stdout } = await execFileAsync('codex', ['--version'], { timeout: 8_000 })
    version = stdout.trim().split('\n')[0] ?? ''
  } catch {
    return { available: false, reason: 'codex CLI not found — install OpenAI Codex CLI' }
  }

  // Check login status
  try {
    const { stdout, stderr } = await execFileAsync('codex', ['login', '--status'], { timeout: 8_000 })
    const combined = (stdout + stderr).toLowerCase()
    if (combined.includes('logged in') || combined.includes('authenticated')) {
      return { available: true, version, loggedIn: true }
    }
    return { available: true, version, loggedIn: false, reason: 'Not logged in — run: codex login' }
  } catch {
    // No --status flag or non-zero exit — check exit code 0 as "logged in"
    return { available: true, version, loggedIn: false, reason: 'Run: codex login to authenticate' }
  }
}

export async function GET(): Promise<NextResponse<ApiResponse<CliStatusData>>> {
  const inDocker = isRunningInDocker()

  if (inDocker) {
    return NextResponse.json({
      success: true,
      data: {
        inDocker: true,
        claudeCode: { available: false, reason: 'CLI backends require the native install — not available inside Docker.' },
        codex:      { available: false, reason: 'CLI backends require the native install — not available inside Docker.' },
      },
    })
  }

  const [claudeCode, codex] = await Promise.all([checkClaude(), checkCodex()])

  return NextResponse.json({
    success: true,
    data: { inDocker: false, claudeCode, codex },
  })
}
