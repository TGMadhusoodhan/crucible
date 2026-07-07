import { describe, expect, it } from 'vitest'
import {
  parseClaudeJsonEnvelope,
  parseClaudeStreamEvent,
  parseCodexJsonlLine,
} from '@/lib/adapters/cli-local'

// ─── Claude JSON envelope (--output-format json) ─────────────────────────────

describe('parseClaudeJsonEnvelope', () => {
  it('extracts result text and cost from a success envelope', () => {
    const raw = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Hello world',
      total_cost_usd: 0.0012,
    })
    const { text, costUsd } = parseClaudeJsonEnvelope(raw)
    expect(text).toBe('Hello world')
    expect(costUsd).toBeCloseTo(0.0012)
  })

  it('returns zero cost when total_cost_usd is absent', () => {
    const raw = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Hi' })
    const { text, costUsd } = parseClaudeJsonEnvelope(raw)
    expect(text).toBe('Hi')
    expect(costUsd).toBe(0)
  })

  it('returns empty text when result is absent', () => {
    const raw = JSON.stringify({ type: 'result', subtype: 'success', is_error: false })
    const { text } = parseClaudeJsonEnvelope(raw)
    expect(text).toBe('')
  })

  it('returns raw input when JSON parse fails', () => {
    const raw = 'not json at all'
    const { text, costUsd } = parseClaudeJsonEnvelope(raw)
    expect(text).toBe('not json at all')
    expect(costUsd).toBe(0)
  })

  it('returns raw input when type is not "result"', () => {
    const raw = JSON.stringify({ type: 'system', subtype: 'init' })
    const { text } = parseClaudeJsonEnvelope(raw)
    expect(text).toBe(raw)
  })
})

// ─── Claude streaming NDJSON (--output-format stream-json) ───────────────────

describe('parseClaudeStreamEvent', () => {
  it('extracts a text_delta token', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
    })
    const result = parseClaudeStreamEvent(line)
    expect(result.token).toBe('Hello')
  })

  it('ignores content_block_start events (no text)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    })
    const result = parseClaudeStreamEvent(line)
    expect(result.token).toBeUndefined()
  })

  it('detects rate_limit_event with status !== allowed', () => {
    const line = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'denied', resetsAt: 9999999999 },
    })
    const result = parseClaudeStreamEvent(line)
    expect(result.rateLimitHit).toBe(true)
    expect(typeof result.retryAfterMs).toBe('number')
  })

  it('does NOT flag rate_limit_event with status=allowed', () => {
    const line = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', resetsAt: 9999999999 },
    })
    const result = parseClaudeStreamEvent(line)
    expect(result.rateLimitHit).toBeUndefined()
  })

  it('extracts finalText and cost from the result line', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Full response',
      total_cost_usd: 0.042,
    })
    const result = parseClaudeStreamEvent(line)
    expect(result.finalText).toBe('Full response')
    expect(result.costUsd).toBeCloseTo(0.042)
    expect(result.rateLimitHit).toBe(false)
  })

  it('flags is_error=true result as rate limit hit', () => {
    const line = JSON.stringify({
      type: 'result',
      is_error: true,
      result: '',
    })
    const result = parseClaudeStreamEvent(line)
    expect(result.rateLimitHit).toBe(true)
  })

  it('returns empty object for blank lines', () => {
    expect(parseClaudeStreamEvent('')).toEqual({})
    expect(parseClaudeStreamEvent('   ')).toEqual({})
  })

  it('returns empty object for malformed JSON', () => {
    expect(parseClaudeStreamEvent('{broken json')).toEqual({})
  })
})

// ─── Codex JSONL event stream ─────────────────────────────────────────────────

describe('parseCodexJsonlLine', () => {
  it('extracts text from agent-message events', () => {
    const line = JSON.stringify({ type: 'agent-message', content: 'Part one' })
    const result = parseCodexJsonlLine(line)
    expect(result.text).toBe('Part one')
  })

  it('extracts text from response message events', () => {
    const line = JSON.stringify({
      type: 'response',
      message: { role: 'assistant', content: 'Part two' },
    })
    const result = parseCodexJsonlLine(line)
    expect(result.text).toBe('Part two')
  })

  it('detects 5-hour window rate limit error', () => {
    const line = JSON.stringify({
      type: 'error',
      error: 'You have exceeded your 5-hour usage window. Please try again later.',
    })
    const result = parseCodexJsonlLine(line)
    expect(result.rateLimitHit).toBe(true)
  })

  it('detects "rate limit" in error message', () => {
    const line = JSON.stringify({ type: 'error', error: 'Rate limit exceeded for this model' })
    const result = parseCodexJsonlLine(line)
    expect(result.rateLimitHit).toBe(true)
  })

  it('does not flag non-limit errors as rate limit', () => {
    const line = JSON.stringify({ type: 'error', error: 'Invalid sandbox configuration' })
    const result = parseCodexJsonlLine(line)
    expect(result.rateLimitHit).toBeUndefined()
  })

  it('returns empty object for unknown event types', () => {
    const line = JSON.stringify({ type: 'tool_call', name: 'read_file' })
    const result = parseCodexJsonlLine(line)
    expect(result.text).toBeUndefined()
    expect(result.rateLimitHit).toBeUndefined()
  })

  it('returns empty object for blank lines', () => {
    expect(parseCodexJsonlLine('')).toEqual({})
    expect(parseCodexJsonlLine('  ')).toEqual({})
  })

  it('returns empty object for malformed JSON', () => {
    expect(parseCodexJsonlLine('{ bad json ]')).toEqual({})
  })
})
