import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { z } from 'zod'
import type { ConversationEvent, ProjectMemory, ReviewFlag, SpecDocument } from '@/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const CRUCIBLE_DIR    = path.join(os.homedir(), '.crucible', 'projects')
const CHARS_PER_TOKEN = 4
const MAX_LOG_TOKENS  = 40_000

// ─── Filesystem availability ──────────────────────────────────────────────────
// Vercel and other serverless runtimes have a read-only filesystem outside /tmp.
// We test write access once and cache the result so the pipeline never crashes
// on a filesystem error — writes are best-effort informational logging only.
// The pipeline state lives in Redis; filesystem is supplementary.

let _canWrite: boolean | null = null

async function canWrite(): Promise<boolean> {
  if (_canWrite !== null) return _canWrite
  try {
    await fs.mkdir(CRUCIBLE_DIR, { recursive: true })
    _canWrite = true
  } catch {
    _canWrite = false
    console.warn('[crucible/filesystem] Server filesystem is read-only — session logs and checkpoints disabled. Pipeline runs normally.')
  }
  return _canWrite
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

export function projectDir(id: string)     { return path.join(CRUCIBLE_DIR, id) }
function memoryPath(id: string)            { return path.join(projectDir(id), 'memory.json') }
function sessionLogPath(id: string)        { return path.join(projectDir(id), 'session_log.jsonl') }
function specPath(id: string)              { return path.join(projectDir(id), 'spec.json') }
function reviewListPath(id: string)        { return path.join(projectDir(id), 'review_list.json') }
function configPath(id: string)            { return path.join(projectDir(id), 'config.json') }
function checkpointsDir(id: string)        { return path.join(projectDir(id), 'checkpoints') }
function outputDir(id: string)             { return path.join(projectDir(id), 'output') }

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const decisionSchema = z.object({
  id:          z.string(),
  description: z.string(),
  reason:      z.string(),
  timestamp:   z.number(),
})

const conflictSchema = z.object({
  id:               z.string(),
  primaryPosition:  z.string(),
  reviewerPosition: z.string(),
  resolvedAt:       z.number().optional(),
  resolution:       z.string().optional(),
})

const activeMemorySchema = z.object({
  current_module:       z.string(),
  open_questions:       z.array(z.string()),
  file_structure:       z.record(z.string(), z.unknown()),
  recent_decisions:     z.array(decisionSchema),
  current_tech_stack:   z.array(z.string()),
  unresolved_conflicts: z.array(conflictSchema),
})

const archiveMemorySchema = z.object({
  completed_modules:     z.array(z.object({
    name:                 z.string(),
    description:          z.string(),
    completedAt:          z.number(),
    interfaceDescription: z.string(),
  })),
  resolved_decisions:    z.array(decisionSchema),
  earlier_architecture:  z.array(z.string()),
  deprecated_approaches: z.array(z.string()),
})

const memorySchema = z.object({
  active:  activeMemorySchema,
  archive: archiveMemorySchema,
})

const checkpointSchema = z.object({
  id:             z.string(),
  trigger:        z.string(),
  summary:        z.string(),
  timestamp:      z.number(),
  outputSnapshot: z.record(z.string(), z.string()),
  memory:         memorySchema,
})

export type CheckpointData = z.infer<typeof checkpointSchema>

// ─── Default structures ───────────────────────────────────────────────────────

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

// ─── Project initialisation ───────────────────────────────────────────────────

export async function initProject(projectId: string): Promise<void> {
  if (!(await canWrite())) return
  try {
    await fs.mkdir(projectDir(projectId),     { recursive: true })
    await fs.mkdir(checkpointsDir(projectId), { recursive: true })
    await fs.mkdir(outputDir(projectId),      { recursive: true })
    try {
      await fs.access(memoryPath(projectId))
    } catch {
      await fs.writeFile(memoryPath(projectId), JSON.stringify(defaultMemory(), null, 2), 'utf-8')
    }
  } catch { /* best-effort */ }
}

/** Alias kept for call sites that use the old name */
export const ensureProjectDir = initProject

// ─── memory.json ──────────────────────────────────────────────────────────────

export async function readMemory(projectId: string): Promise<ProjectMemory> {
  try {
    const raw = await fs.readFile(memoryPath(projectId), 'utf-8')
    return memorySchema.parse(JSON.parse(raw)) as ProjectMemory
  } catch {
    return defaultMemory()
  }
}

export async function writeMemory(projectId: string, memory: ProjectMemory): Promise<void> {
  try {
    await initProject(projectId)
    await fs.writeFile(memoryPath(projectId), JSON.stringify(memory, null, 2), 'utf-8')
  } catch { /* best-effort */ }
}

// ─── session_log.jsonl (append-only — NEVER overwrite or delete) ──────────────

export async function appendSessionLog(projectId: string, event: ConversationEvent): Promise<void> {
  try {
    await initProject(projectId)
    await fs.appendFile(sessionLogPath(projectId), JSON.stringify(event) + '\n', 'utf-8')
  } catch { /* best-effort */ }
}

/**
 * Reads the last `maxTokens` worth of session log entries (default 40k).
 * Returns events in chronological order.
 */
export async function readRecentSessionLog(
  projectId: string,
  maxTokens = MAX_LOG_TOKENS,
): Promise<ConversationEvent[]> {
  try {
    const raw   = await fs.readFile(sessionLogPath(projectId), 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim())

    const selected: ConversationEvent[] = []
    let charCount = 0
    const maxChars = maxTokens * CHARS_PER_TOKEN

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!
      charCount += line.length
      if (charCount > maxChars) break
      try {
        selected.unshift(JSON.parse(line) as ConversationEvent)
      } catch { /* skip malformed lines */ }
    }

    return selected
  } catch {
    return []
  }
}

export async function readFullSessionLog(projectId: string): Promise<ConversationEvent[]> {
  try {
    const raw = await fs.readFile(sessionLogPath(projectId), 'utf-8')
    return raw
      .split('\n')
      .filter(l => l.trim())
      .flatMap(l => { try { return [JSON.parse(l) as ConversationEvent] } catch { return [] } })
  } catch {
    return []
  }
}

// ─── spec.json (write ONCE — error if already exists) ────────────────────────

export async function writeSpec(projectId: string, spec: SpecDocument): Promise<void> {
  try {
    await initProject(projectId)
    const p = specPath(projectId)
    try {
      await fs.access(p)
      throw new Error(`spec.json already exists for project ${projectId}. The spec cannot be overwritten.`)
    } catch (err) {
      if (err instanceof Error && err.message.includes('already exists')) throw err
      await fs.writeFile(p, JSON.stringify(spec, null, 2), 'utf-8')
    }
  } catch (err) {
    // Re-throw intentional guard; swallow IO errors (read-only fs)
    if (err instanceof Error && err.message.includes('already exists')) throw err
    // best-effort
  }
}

export async function readSpec(projectId: string): Promise<SpecDocument | null> {
  try {
    const raw = await fs.readFile(specPath(projectId), 'utf-8')
    return JSON.parse(raw) as SpecDocument
  } catch {
    return null
  }
}

export async function specExists(projectId: string): Promise<boolean> {
  try { await fs.access(specPath(projectId)); return true } catch { return false }
}

// ─── review_list.json (append-only low-confidence flags) ─────────────────────

export async function appendReviewList(projectId: string, flag: ReviewFlag): Promise<void> {
  try {
    await initProject(projectId)
    const p = reviewListPath(projectId)
    let list: ReviewFlag[] = []
    try {
      const raw = await fs.readFile(p, 'utf-8')
      list = JSON.parse(raw) as ReviewFlag[]
    } catch { /* file doesn't exist yet */ }
    list.push(flag)
    await fs.writeFile(p, JSON.stringify(list, null, 2), 'utf-8')
  } catch { /* best-effort */ }
}

export async function readReviewList(projectId: string): Promise<ReviewFlag[]> {
  try {
    const raw = await fs.readFile(reviewListPath(projectId), 'utf-8')
    return JSON.parse(raw) as ReviewFlag[]
  } catch {
    return []
  }
}

// ─── config.json ──────────────────────────────────────────────────────────────

export async function readProjectConfig(projectId: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(configPath(projectId), 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function writeProjectConfig(projectId: string, config: Record<string, unknown>): Promise<void> {
  try {
    await initProject(projectId)
    await fs.writeFile(configPath(projectId), JSON.stringify(config, null, 2), 'utf-8')
  } catch { /* best-effort */ }
}

// ─── Output files (consensus-validated code) ──────────────────────────────────

export async function writeOutput(projectId: string, filename: string, content: string): Promise<void> {
  try {
    await initProject(projectId)
    const safe = path.basename(filename)
    await fs.writeFile(path.join(outputDir(projectId), safe), content, 'utf-8')
  } catch { /* best-effort */ }
}

/** Alias kept for call sites that use the old name */
export const writeOutputFile = writeOutput

export async function readOutputFile(projectId: string, filename: string): Promise<string> {
  return fs.readFile(path.join(outputDir(projectId), path.basename(filename)), 'utf-8')
}

export async function listOutputFiles(projectId: string): Promise<string[]> {
  try { return fs.readdir(outputDir(projectId)) } catch { return [] }
}

// ─── Checkpoints ─────────────────────────────────────────────────────────────

export async function saveCheckpoint(
  projectId: string,
  trigger: 'module_complete' | 'conflict_resolved' | 'human_confirm' | 'manual',
  summary: string,
  outputSnapshot: Record<string, string> = {},
): Promise<string> {
  const id = `${Date.now()}_${trigger}`
  try {
    await initProject(projectId)
    const memory  = await readMemory(projectId)
    const payload: CheckpointData = { id, trigger, summary, timestamp: Date.now(), outputSnapshot, memory }
    await fs.writeFile(
      path.join(checkpointsDir(projectId), `${id}.json`),
      JSON.stringify(payload, null, 2),
      'utf-8',
    )
  } catch { /* best-effort */ }
  return id
}

export async function listCheckpoints(projectId: string): Promise<Array<Pick<CheckpointData, 'id' | 'trigger' | 'timestamp' | 'summary'>>> {
  try {
    const files = await fs.readdir(checkpointsDir(projectId))
    const results = await Promise.all(
      files.filter(f => f.endsWith('.json')).map(async f => {
        try {
          const raw  = await fs.readFile(path.join(checkpointsDir(projectId), f), 'utf-8')
          const data = checkpointSchema.parse(JSON.parse(raw))
          return { id: data.id, trigger: data.trigger, timestamp: data.timestamp, summary: data.summary }
        } catch { return null }
      }),
    )
    return results
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.timestamp - a.timestamp)
  } catch {
    return []
  }
}

// ─── Token estimation (used by memory compression) ────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}
