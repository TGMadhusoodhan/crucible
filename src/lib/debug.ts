/**
 * Crucible debug logger — prints to server stdout with a consistent prefix.
 * Every log line is prefixed with [crucible:<phase>] so you can grep by phase.
 * Never logs API keys, tokens, or raw user code (code is always length-only).
 *
 * Disabled in production unless CRUCIBLE_DEBUG=1 is set explicitly.
 */

const ENABLED =
  process.env.NODE_ENV !== 'production' || process.env.CRUCIBLE_DEBUG === '1'

function ts(): string {
  return new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
}

function fmt(phase: string, msg: string, data?: Record<string, unknown>): string {
  const base = `[crucible:${phase}] ${ts()} ${msg}`
  if (!data || Object.keys(data).length === 0) return base
  const safe = JSON.stringify(data, null, 0)
  return `${base} ${safe}`
}

function log(phase: string, msg: string, data?: Record<string, unknown>): void {
  if (!ENABLED) return
  console.log(fmt(phase, msg, data))
}

export const dbg = {
  /** Orchestrator-level events: session create, phase transitions, adapter wiring */
  orch: (msg: string, data?: Record<string, unknown>) =>
    log('orch', msg, data),

  /** Phase 1: parallel thinking */
  phase1: (msg: string, data?: Record<string, unknown>) =>
    log('phase1', msg, data),

  /** Phase 1.5: alignment */
  align: (msg: string, data?: Record<string, unknown>) =>
    log('align', msg, data),

  /** Phase 2: questions + spec */
  phase2: (msg: string, data?: Record<string, unknown>) =>
    log('phase2', msg, data),

  /** Phase 3: scaffold (hybrid only) */
  scaffold: (msg: string, data?: Record<string, unknown>) =>
    log('scaffold', msg, data),

  /** Phase 3: code generation */
  gen: (msg: string, data?: Record<string, unknown>) =>
    log('gen', msg, data),

  /** Phase 3: self-check */
  selfcheck: (msg: string, data?: Record<string, unknown>) =>
    log('selfcheck', msg, data),

  /** Phase 3: cross-model review */
  review: (msg: string, data?: Record<string, unknown>) =>
    log('review', msg, data),

  /** Phase 3b: reviewer edit hunks */
  edit: (msg: string, data?: Record<string, unknown>) =>
    log('edit', msg, data),

  /** Phase 3b: coder verify */
  verify: (msg: string, data?: Record<string, unknown>) =>
    log('verify', msg, data),

  /** Phase 3b: model dialogue */
  dialogue: (msg: string, data?: Record<string, unknown>) =>
    log('dialogue', msg, data),

  /** Phase 3: consensus + file gate */
  consensus: (msg: string, data?: Record<string, unknown>) =>
    log('consensus', msg, data),

  /** Adapter construction */
  adapter: (msg: string, data?: Record<string, unknown>) =>
    log('adapter', msg, data),
}
