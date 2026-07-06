import fs   from 'fs'
import path from 'path'
import type { ConversationEvent, ProjectMemory, SpecDocument } from '@/types'
import { estimateTokens } from '@/lib/utils/tokens'

// ─── Paths ────────────────────────────────────────────────────────────────────

// Read lazily so tests can override DATA_DIR via process.env after module load.
function getDataDir(): string { return process.env.DATA_DIR ?? './data' }

function projectDir(projectId: string): string {
  return path.join(getDataDir(), 'projects', projectId)
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

// ─── Project init ─────────────────────────────────────────────────────────────

export function initProject(projectId: string): void {
  ensureDir(projectDir(projectId))
  ensureDir(path.join(projectDir(projectId), 'output'))
}

export { estimateTokens }

// ─── Default memory ───────────────────────────────────────────────────────────

export function defaultMemory(): ProjectMemory {
  return {
    active: {
      current_module:       '',
      open_questions:       [],
      file_structure:       {},
      recent_decisions:     [],
      current_tech_stack:   [],
      unresolved_conflicts: [],
    },
    archive: {
      completed_modules:     [],
      resolved_decisions:    [],
      earlier_architecture:  [],
      deprecated_approaches: [],
    },
  }
}

// ─── Memory ───────────────────────────────────────────────────────────────────

export function readMemory(projectId: string): ProjectMemory {
  const file = path.join(projectDir(projectId), 'memory.json')
  try {
    if (!fs.existsSync(file)) return defaultMemory()
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectMemory
  } catch {
    return defaultMemory()
  }
}

export function writeMemory(projectId: string, memory: ProjectMemory): void {
  ensureDir(projectDir(projectId))
  fs.writeFileSync(
    path.join(projectDir(projectId), 'memory.json'),
    JSON.stringify(memory, null, 2),
  )
}

// ─── Session log ─────────────────────────────────────────────────────────────

const MAX_LOG_TOKENS  = 40_000
const CHARS_PER_TOKEN = 4

export function appendSessionLog(projectId: string, event: ConversationEvent): void {
  ensureDir(projectDir(projectId))
  const file = path.join(projectDir(projectId), 'session.jsonl')
  fs.appendFileSync(file, JSON.stringify(event) + '\n')
}

export function readRecentSessionLog(
  projectId: string,
  maxTokens = MAX_LOG_TOKENS,
): ConversationEvent[] {
  const file = path.join(projectDir(projectId), 'session.jsonl')
  try {
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    const events: ConversationEvent[] = []
    let charCount = 0
    const maxChars = maxTokens * CHARS_PER_TOKEN
    for (let i = lines.length - 1; i >= 0; i--) {
      charCount += (lines[i]?.length ?? 0)
      if (charCount > maxChars) break
      try { events.unshift(JSON.parse(lines[i]!) as ConversationEvent) } catch { /* skip */ }
    }
    return events
  } catch {
    return []
  }
}

export function readFullSessionLog(projectId: string): ConversationEvent[] {
  const file = path.join(projectDir(projectId), 'session.jsonl')
  try {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8')
      .trim().split('\n').filter(Boolean)
      .flatMap(line => { try { return [JSON.parse(line) as ConversationEvent] } catch { return [] } })
  } catch {
    return []
  }
}

// ─── Spec ─────────────────────────────────────────────────────────────────────

export function writeSpec(projectId: string, spec: SpecDocument): void {
  const file = path.join(projectDir(projectId), 'spec.json')
  if (fs.existsSync(file)) {
    throw new Error(`spec already exists for project ${projectId}. The spec cannot be overwritten.`)
  }
  ensureDir(projectDir(projectId))
  fs.writeFileSync(file, JSON.stringify(spec, null, 2))
}

export function readSpec(projectId: string): SpecDocument | null {
  const file = path.join(projectDir(projectId), 'spec.json')
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SpecDocument
  } catch {
    return null
  }
}

export function specExists(projectId: string): boolean {
  return fs.existsSync(path.join(projectDir(projectId), 'spec.json'))
}

// ─── Output files ─────────────────────────────────────────────────────────────

export function writeOutput(projectId: string, filename: string, content: string): void {
  const outDir  = path.join(projectDir(projectId), 'output')
  // Prevent path traversal — filenames can come from a URL param or a
  // model-generated manifest, neither of which is trusted. Mirrors the same
  // resolve+prefix check readOutputFile uses below.
  const fullPath = path.resolve(outDir, filename)
  const safeBase = path.resolve(outDir) + path.sep
  if (!fullPath.startsWith(safeBase) && fullPath !== path.resolve(outDir)) {
    throw new Error('Invalid filename')
  }
  ensureDir(path.dirname(fullPath))   // create any intermediate dirs (e.g. src/app/)
  fs.writeFileSync(fullPath, content)
}

export const writeOutputFile = writeOutput

export function readOutputFile(projectId: string, filename: string): string {
  const outDir   = path.join(projectDir(projectId), 'output')
  // Prevent path traversal — use sep suffix to avoid '/output2' passing '/output' check
  const resolved = path.resolve(outDir, filename)
  const safeBase = path.resolve(outDir) + path.sep
  if (!resolved.startsWith(safeBase) && resolved !== path.resolve(outDir)) {
    throw new Error('Invalid filename')
  }
  if (!fs.existsSync(resolved)) throw new Error(`Output file not found: ${filename}`)
  return fs.readFileSync(resolved, 'utf8')
}

export function listOutputFiles(projectId: string): string[] {
  const outDir = path.join(projectDir(projectId), 'output')
  try {
    if (!fs.existsSync(outDir)) return []
    return readdirRecursive(outDir, outDir)
  } catch {
    return []
  }
}

function readdirRecursive(baseDir: string, dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...readdirRecursive(baseDir, full))
    } else {
      results.push(path.relative(baseDir, full))
    }
  }
  return results
}

// ─── Checkpoints ─────────────────────────────────────────────────────────────

export interface CheckpointData {
  id:             string
  trigger:        string
  summary:        string
  timestamp:      number
  outputSnapshot: Record<string, string>
  memory:         ProjectMemory
}

export function saveCheckpoint(
  projectId: string,
  trigger:   'module_complete' | 'conflict_resolved' | 'human_confirm' | 'manual',
  summary:   string,
  outputSnapshot: Record<string, string> = {},
): string {
  const id      = `${Date.now()}_${trigger}`
  const memory  = readMemory(projectId)
  const payload: CheckpointData = { id, trigger, summary, timestamp: Date.now(), outputSnapshot, memory }
  const dir     = path.join(projectDir(projectId), 'checkpoints')
  ensureDir(dir)
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(payload, null, 2))
  return id
}

export function listCheckpoints(
  projectId: string,
): Array<Pick<CheckpointData, 'id' | 'trigger' | 'timestamp' | 'summary'>> {
  const dir = path.join(projectDir(projectId), 'checkpoints')
  try {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .flatMap(f => {
        try {
          const cp = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as CheckpointData
          return [{ id: cp.id, trigger: cp.trigger, timestamp: cp.timestamp, summary: cp.summary }]
        } catch { return [] }
      })
      .sort((a, b) => b.timestamp - a.timestamp)
  } catch {
    return []
  }
}

// ─── Project config ───────────────────────────────────────────────────────────

export function readProjectConfig(projectId: string): Record<string, unknown> {
  const file = path.join(projectDir(projectId), 'config.json')
  try {
    if (!fs.existsSync(file)) return {}
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function writeProjectConfig(projectId: string, config: Record<string, unknown>): void {
  ensureDir(projectDir(projectId))
  fs.writeFileSync(path.join(projectDir(projectId), 'config.json'), JSON.stringify(config, null, 2))
}

// ─── Compat stubs ─────────────────────────────────────────────────────────────

export function projectDir_(id: string): string { return projectDir(id) }
export const ensureProjectDir = (id: string) => ensureDir(projectDir(id))
