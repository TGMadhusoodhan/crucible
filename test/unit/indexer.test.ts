import { describe, it, expect } from 'vitest'
import { buildSignatureBlock } from '@/lib/workspace/indexer'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lines(block: string): string[] {
  return block.split('\n').filter(Boolean)
}

// ─── Fixture 1: simple function + const exports ───────────────────────────────

describe('buildSignatureBlock — function and const exports', () => {
  const code = `
import { Helper } from './helper'
import { readFileSync } from 'fs'   // node_modules — excluded from imports line

export function add(a: number, b: number): number {
  return a + b
}

export async function fetchUser(id: string): Promise<User> {
  return fetch(id).then(r => r.json())
}

export const VERSION: string = '1.0.0'
export let counter = 0

function internal(): void { /* not exported */ }
`

  it('emits file header', () => {
    const block = buildSignatureBlock('src/utils.ts', code)
    expect(block).toContain('## src/utils.ts')
  })

  it('includes only local imports', () => {
    const block = buildSignatureBlock('src/utils.ts', code)
    expect(block).toContain('imports: ./helper')
    expect(block).not.toContain('fs')   // node_modules excluded
  })

  it('emits exported function signatures', () => {
    const block = buildSignatureBlock('src/utils.ts', code)
    expect(block).toContain('export function add(a: number, b: number): number')
    expect(block).toContain('export async function fetchUser(id: string): Promise<User>')
  })

  it('emits exported const with type annotation', () => {
    const block = buildSignatureBlock('src/utils.ts', code)
    expect(block).toContain('export const VERSION: string')
  })

  it('emits exported let without annotation', () => {
    const block = buildSignatureBlock('src/utils.ts', code)
    expect(block).toContain('export let counter')
  })

  it('excludes non-exported functions', () => {
    const block = buildSignatureBlock('src/utils.ts', code)
    expect(block).not.toContain('internal')
  })
})

// ─── Fixture 2: interface and type alias exports ──────────────────────────────

describe('buildSignatureBlock — interfaces and type aliases', () => {
  const code = `
export interface User {
  id: string
  name: string
  email?: string
  role: 'admin' | 'user'
}

export type UserId = string

export type Status = 'active' | 'inactive' | 'pending'

interface Internal { secret: string }  // not exported
`

  it('includes exported interface text', () => {
    const block = buildSignatureBlock('src/types.ts', code)
    expect(block).toContain('export interface User')
    expect(block).toContain('id: string')
  })

  it('includes exported type aliases', () => {
    const block = buildSignatureBlock('src/types.ts', code)
    expect(block).toContain('export type UserId = string')
    expect(block).toContain('export type Status')
  })

  it('excludes non-exported interfaces', () => {
    const block = buildSignatureBlock('src/types.ts', code)
    expect(block).not.toContain('Internal')
    expect(block).not.toContain('secret')
  })
})

// ─── Fixture 3: class with public methods and readonly props ──────────────────

describe('buildSignatureBlock — class signatures', () => {
  const code = `
export class WorkerPool {
  private connections: Map<string, unknown> = new Map()
  readonly maxSize: number
  static readonly defaultTimeout = 5000

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  start(): void { /* ... */ }
  async stop(): Promise<void> { /* ... */ }
  getSize(): number { return this.connections.size }

  private cleanup(): void { /* not included */ }
  protected drain(): void { /* not included */ }
}
`

  it('includes public methods', () => {
    const block = buildSignatureBlock('src/worker.ts', code)
    expect(block).toContain('start(): void')
    expect(block).toContain('async stop(): Promise<void>')
    expect(block).toContain('getSize(): number')
  })

  it('includes readonly properties', () => {
    const block = buildSignatureBlock('src/worker.ts', code)
    expect(block).toContain('readonly maxSize: number')
  })

  it('includes static readonly properties', () => {
    const block = buildSignatureBlock('src/worker.ts', code)
    expect(block).toContain('static readonly defaultTimeout')
  })

  it('excludes private and protected members', () => {
    const block = buildSignatureBlock('src/worker.ts', code)
    expect(block).not.toContain('connections')
    expect(block).not.toContain('cleanup')
    expect(block).not.toContain('drain')
  })

  it('emits export class header', () => {
    const block = buildSignatureBlock('src/worker.ts', code)
    expect(block).toContain('export class WorkerPool')
  })
})

// ─── Fixture 4: default export and function overloads ────────────────────────

describe('buildSignatureBlock — default exports and overloads', () => {
  const namedDefault = `
export default function handleRequest(req: Request): Response {
  return new Response('ok')
}
`

  const anonDefault = `
export default function(input: string): number {
  return parseInt(input)
}
`

  const overloads = `
export function schedule(job: Job): Promise<Handle>
export function schedule(job: Job, opts: Opts): Promise<Handle>
export function schedule(job: Job, opts?: Opts): Promise<Handle> {
  return runJob(job, opts)
}
`

  it('emits named default export', () => {
    const block = buildSignatureBlock('src/handler.ts', namedDefault)
    expect(block).toContain('default')
    expect(block).toContain('handleRequest')
    expect(block).toContain('req: Request')
    expect(block).toContain('Response')
  })

  it('emits anonymous default export', () => {
    const block = buildSignatureBlock('src/handler.ts', anonDefault)
    expect(block).toContain('default')
    expect(block).toContain('input: string')
    expect(block).toContain('number')
  })

  it('emits all overload signatures', () => {
    const block = buildSignatureBlock('src/scheduler.ts', overloads)
    const occurrences = (block.match(/export function schedule/g) ?? []).length
    expect(occurrences).toBeGreaterThanOrEqual(2)  // at least both overloads
  })
})

// ─── Fixture 5: re-exports ────────────────────────────────────────────────────

describe('buildSignatureBlock — re-exports', () => {
  const code = `
export { add, multiply } from './math'
export { User as UserModel } from './types'
export type { Config } from './config'
export * from './utils'
`

  it('emits named re-exports', () => {
    const block = buildSignatureBlock('src/index.ts', code)
    expect(block).toContain('export { add, multiply }')
    expect(block).toContain("from './math'")
  })

  it('emits aliased re-exports', () => {
    const block = buildSignatureBlock('src/index.ts', code)
    expect(block).toContain('User as UserModel')
  })

  it('emits type-only re-exports', () => {
    const block = buildSignatureBlock('src/index.ts', code)
    expect(block).toContain('type')
    expect(block).toContain('Config')
  })

  it('emits wildcard re-exports', () => {
    const block = buildSignatureBlock('src/index.ts', code)
    expect(block).toContain("export * from './utils'")
  })
})

// ─── Non-TS file fallback ─────────────────────────────────────────────────────

describe('buildSignatureBlock — non-TS file', () => {
  it('returns a safe fallback for unsupported extensions', () => {
    const block = buildSignatureBlock('styles/main.css', '.foo { color: red }')
    expect(block).toContain('## styles/main.css')
    expect(block).toContain('non-TS file')
  })
})
