import { spawn } from 'child_process'
import os from 'os'
import fs from 'fs'
import path from 'path'
import type { AlignmentMessage, Provider, ThinkingOutput } from '@/types'
import { alignmentOutputSchema } from '@/lib/schemas'
import {
  ALIGNMENT_SYSTEM_PROMPT,
  THINKING_SYSTEM_PROMPT,
  BaseAdapter,
  buildAlignmentPrompt,
  buildThinkingPrompt,
  isUnparseableThinkingOutput,
  parseJSON,
  parseThinkingOutput,
  parseWithRepair,
  type StreamUsage,
} from './base'

// ─── Concurrency limiter — max 2 live children per backend ───────────────────

class Semaphore {
  private count = 0
  private readonly queue: Array<() => void> = []
  constructor(private readonly max: number) {}

  acquire(): Promise<() => void> {
    return new Promise(resolve => {
      const tryAcquire = () => {
        if (this.count < this.max) {
          this.count++
          resolve(() => {
            this.count--
            const next = this.queue.shift()
            if (next) next()
          })
        } else {
          this.queue.push(tryAcquire)
        }
      }
      tryAcquire()
    })
  }
}

const SEMAPHORES: Record<string, Semaphore> = {
  'claude-code': new Semaphore(2),
  'codex':       new Semaphore(2),
}

const TIMEOUT_MS = 300_000

// Scrubbed env: subscription auth relies on HOME (keychain / ~/.claude/) and PATH only.
// Cast is safe — spawn's `options.env` accepts a partial-like record at runtime
// even though the NodeJS type definition marks all keys as required.
function scrubEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? os.homedir(),
  }
}

export function isRunningInDocker(): boolean {
  return !!process.env.CRUCIBLE_IN_DOCKER || fs.existsSync('/.dockerenv')
}

// ─── Error type that the existing withRetry retry layer recognises as 429 ────

class SubscriptionLimitError extends Error {
  readonly status = 429
  readonly retryAfterMs?: number
  constructor(message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'SubscriptionLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

// ─── Claude JSON envelope parser (--output-format json) ──────────────────────

interface ClaudeResultEnvelope {
  type:           string
  subtype?:       string
  is_error?:      boolean
  result?:        string
  total_cost_usd?: number
}

export function parseClaudeJsonEnvelope(raw: string): { text: string; costUsd: number } {
  try {
    const obj = JSON.parse(raw.trim()) as ClaudeResultEnvelope
    if (obj.type === 'result') {
      return { text: obj.result ?? '', costUsd: obj.total_cost_usd ?? 0 }
    }
  } catch { /* not JSON — return raw */ }
  return { text: raw, costUsd: 0 }
}

// ─── Claude streaming NDJSON parser (--output-format stream-json) ────────────

interface ClaudeStreamLine {
  type: string
  event?: {
    type: string
    index?: number
    delta?: { type?: string; text?: string }
  }
  rate_limit_info?: { status: string; resetsAt?: number }
  is_error?: boolean
  result?: string
  total_cost_usd?: number
}

export function parseClaudeStreamEvent(line: string): {
  token?: string
  finalText?: string
  costUsd?: number
  rateLimitHit?: boolean
  retryAfterMs?: number
} {
  if (!line.trim()) return {}
  try {
    const obj = JSON.parse(line) as ClaudeStreamLine

    if (
      obj.type === 'stream_event' &&
      obj.event?.type === 'content_block_delta' &&
      obj.event.delta?.type === 'text_delta' &&
      obj.event.delta.text
    ) {
      return { token: obj.event.delta.text }
    }

    if (obj.type === 'rate_limit_event' && obj.rate_limit_info?.status !== 'allowed') {
      const info = obj.rate_limit_info
      const retryAfterMs = info?.resetsAt
        ? Math.max(0, info.resetsAt * 1_000 - Date.now())
        : undefined
      return { rateLimitHit: true, retryAfterMs }
    }

    if (obj.type === 'result') {
      return {
        finalText: obj.result ?? '',
        costUsd:   obj.total_cost_usd ?? 0,
        rateLimitHit: !!obj.is_error,
      }
    }
  } catch { /* skip malformed line */ }
  return {}
}

// ─── Codex JSONL event parser ─────────────────────────────────────────────────

interface CodexEventLine {
  type:     string
  content?: string
  message?: { role?: string; content?: string }
  error?:   string
}

export function parseCodexJsonlLine(line: string): {
  text?: string
  rateLimitHit?: boolean
} {
  if (!line.trim()) return {}
  try {
    const obj = JSON.parse(line) as CodexEventLine
    if (obj.type === 'agent-message' && obj.content) return { text: obj.content }
    if (obj.type === 'response' && obj.message?.content) return { text: obj.message.content }
    if (obj.type === 'error' && obj.error) {
      const lower = obj.error.toLowerCase()
      if (lower.includes('5-hour') || lower.includes('rate limit') || lower.includes('usage limit')) {
        return { rateLimitHit: true }
      }
    }
  } catch { /* skip */ }
  return {}
}

// ─── Low-level spawn helper ───────────────────────────────────────────────────

function spawnCli(
  cmd:    string,
  args:   string[],
  env:    Record<string, string>,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      env: env as NodeJS.ProcessEnv,
      cwd:   os.tmpdir(),  // neutral dir — avoids loading CLAUDE.md / hooks
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, TIMEOUT_MS)

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    if (stdin !== undefined) {
      proc.stdin.write(stdin)
      proc.stdin.end()
    } else {
      proc.stdin.end()
    }

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`spawn ${cmd} failed: ${err.message}`))
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${TIMEOUT_MS / 1000}s`))
      } else {
        resolve({ stdout, stderr, exitCode: code ?? 0 })
      }
    })
  })
}

// ─── Streaming spawn helper (line-by-line callback) ──────────────────────────

function spawnCliStreaming(
  cmd:        string,
  args:       string[],
  env:        Record<string, string>,
  onLine:     (line: string) => void,
  stdin?:     string,
): Promise<{ stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      env: env as NodeJS.ProcessEnv,
      cwd:   os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let lineBuffer = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, TIMEOUT_MS)

    proc.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString()
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    })

    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    if (stdin !== undefined) {
      proc.stdin.write(stdin)
      proc.stdin.end()
    } else {
      proc.stdin.end()
    }

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`spawn ${cmd} failed: ${err.message}`))
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      // Flush any remaining partial line
      if (lineBuffer.trim()) onLine(lineBuffer)
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${TIMEOUT_MS / 1000}s`))
      } else {
        resolve({ stderr, exitCode: code ?? 0 })
      }
    })
  })
}

// ─── CliLocalAdapter ──────────────────────────────────────────────────────────

export class CliLocalAdapter extends BaseAdapter {
  private readonly cliProvider: 'claude-code' | 'codex'
  private readonly semaphore:   Semaphore

  constructor(provider: 'claude-code' | 'codex', private readonly modelId: string) {
    super()
    this.cliProvider = provider
    this.semaphore   = SEMAPHORES[provider]!
  }

  getProvider(): Provider { return this.cliProvider }
  getModelId():  string   { return this.modelId }

  estimateCost(_inputTokens: number, _outputTokens: number): number { return 0 }

  // ─── completeNonStreaming — transport primitive ──────────────────────────────

  protected async completeNonStreaming(systemPrompt: string, userMsg: string): Promise<string> {
    const release = await this.semaphore.acquire()
    try {
      if (this.cliProvider === 'claude-code') {
        return await this.claudeComplete(systemPrompt, userMsg)
      } else {
        return await this.codexComplete(systemPrompt, userMsg)
      }
    } finally {
      release()
    }
  }

  // ─── stream — transport primitive ───────────────────────────────────────────
  // CLI backends are reviewer-only; generate/applyPatch/fixFile (coder ops) are
  // never called on them. stream() is implemented for interface compliance only.
  // Uses the same non-streaming path and emits output as a single token batch.

  protected async stream(
    systemPrompt: string,
    userMsg:      string,
    onToken:      (token: string) => void,
  ): Promise<StreamUsage> {
    if (this.cliProvider === 'claude-code') {
      return await this.claudeStream(systemPrompt, userMsg, onToken)
    } else {
      const text = await this.codexComplete(systemPrompt, userMsg)
      onToken(text)
      return { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    }
  }

  // ─── Claude implementation ───────────────────────────────────────────────────

  private async claudeComplete(systemPrompt: string, userMsg: string): Promise<string> {
    const combined = `${userMsg}`
    const { stdout } = await spawnCli(
      'claude',
      ['-p', combined, '--system-prompt', systemPrompt, '--output-format', 'json', '--allowedTools', ''],
      scrubEnv(),
    )
    const { text, costUsd } = parseClaudeJsonEnvelope(stdout)
    // Check for subscription limit in the envelope text
    if (!text && stdout.includes('usage_limit')) {
      throw new SubscriptionLimitError('Claude subscription limit reached')
    }
    void costUsd  // cost is reported via estimateCost bypass; no recordUsage here
    return text
  }

  private async claudeStream(
    systemPrompt: string,
    userMsg:      string,
    onToken:      (token: string) => void,
  ): Promise<StreamUsage> {
    const combined = `${userMsg}`
    let costUsd = 0
    let rateLimitHit = false
    let retryAfterMs: number | undefined

    await spawnCliStreaming(
      'claude',
      [
        '-p', combined,
        '--system-prompt', systemPrompt,
        '--verbose',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--allowedTools', '',
      ],
      scrubEnv(),
      (line) => {
        const parsed = parseClaudeStreamEvent(line)
        if (parsed.token)        onToken(parsed.token)
        if (parsed.costUsd)      costUsd = parsed.costUsd
        if (parsed.rateLimitHit) { rateLimitHit = true; retryAfterMs = parsed.retryAfterMs }
      },
    )

    if (rateLimitHit) {
      throw new SubscriptionLimitError('Claude subscription limit reached', retryAfterMs)
    }

    return { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  }

  // ─── Codex implementation ────────────────────────────────────────────────────

  private async codexComplete(systemPrompt: string, userMsg: string): Promise<string> {
    const stdinPayload = `SYSTEM INSTRUCTIONS:\n${systemPrompt}\n\n${userMsg}`
    const { stdout } = await spawnCli(
      'codex',
      ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-'],
      scrubEnv(),
      stdinPayload,
    )

    const lines = stdout.split('\n')
    const parts: string[] = []
    let rateLimitHit = false

    for (const line of lines) {
      const parsed = parseCodexJsonlLine(line)
      if (parsed.text)         parts.push(parsed.text)
      if (parsed.rateLimitHit) rateLimitHit = true
    }

    if (rateLimitHit) throw new SubscriptionLimitError('Codex subscription limit reached')

    return parts.join('')
  }

  // ─── Phase 1: Think ──────────────────────────────────────────────────────────

  async think(taskDescription: string, contextText?: string): Promise<ThinkingOutput> {
    const prompt = buildThinkingPrompt(taskDescription, contextText)
    const release = await this.semaphore.acquire()
    let raw: string
    try {
      raw = this.cliProvider === 'claude-code'
        ? await this.claudeComplete(THINKING_SYSTEM_PROMPT, prompt)
        : await this.codexComplete(THINKING_SYSTEM_PROMPT, prompt)
    } finally {
      release()
    }

    const output = parseThinkingOutput(raw, this.cliProvider, this.modelId, 0)
    if (isUnparseableThinkingOutput(output)) {
      // One repair attempt via non-streaming path
      try {
        const repaired = await parseWithRepair(
          raw,
          // reuse thinkingOutputSchema inline
          (await import('@/types')).thinkingOutputSchema,
          (err) => this.completeNonStreaming(THINKING_SYSTEM_PROMPT,
            `Your previous response could not be parsed as JSON. Error: ${err}\nTask: ${taskDescription.slice(0, 300)}\n\nRespond with ONLY the required JSON — no markdown fences, no prose.`),
          'think',
        )
        return { ...repaired, provider: this.cliProvider, model_id: this.modelId, tokens_used: 0 }
      } catch {
        return output  // return the fallback
      }
    }
    return output
  }

  // ─── Phase 1.5: Alignment chat ───────────────────────────────────────────────

  async chat(
    taskDescription: string,
    otherThinking:   ThinkingOutput,
    myThinking:      ThinkingOutput,
    round:           1 | 2,
  ): Promise<AlignmentMessage> {
    const prompt = buildAlignmentPrompt(round, taskDescription, myThinking, otherThinking)
    const raw    = await this.completeNonStreaming(ALIGNMENT_SYSTEM_PROMPT, prompt)

    const parsed = parseJSON<Record<string, unknown>>(raw, 'alignment')
    const schema = alignmentOutputSchema

    let validated
    try {
      validated = await parseWithRepair(
        raw, schema,
        (err) => this.completeNonStreaming(ALIGNMENT_SYSTEM_PROMPT,
          `Your previous response could not be parsed. Error: ${err}\nRespond with ONLY the corrected JSON — no markdown fences, no prose.`),
        'chat',
      )
    } catch {
      return this.makeAlignmentMessage(round, 'reviewer', parsed ?? {})
    }

    return this.makeAlignmentMessage(round, 'reviewer', validated as Record<string, unknown>)
  }
}
