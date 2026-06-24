// Redis-backed storage — replaces the Node.js filesystem layer.
// Works identically on Vercel serverless and local dev.
// Public API is unchanged so no other file needs to be updated.

import { Redis } from '@upstash/redis'
import type { ConversationEvent, ProjectMemory, ReviewFlag, SpecDocument } from '@/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN  = 4
const MAX_LOG_TOKENS   = 40_000
const MAX_LOG_ENTRIES  = 10_000   // list cap — trims oldest on append
const MAX_REVIEW_ITEMS = 1_000
const MAX_CHECKPOINTS  = 100

const TTL_LOG  = 60 * 60 * 24 * 90    // session logs: 90 days
const TTL_DATA = 60 * 60 * 24 * 365   // project data: 1 year

// ─── Redis keys ───────────────────────────────────────────────────────────────

const KEY = {
  sessionLog:  (pid: string)              => `fs:${pid}:session_log`,
  memory:      (pid: string)              => `fs:${pid}:memory`,
  spec:        (pid: string)              => `fs:${pid}:spec`,
  reviewList:  (pid: string)              => `fs:${pid}:reviews`,
  config:      (pid: string)              => `fs:${pid}:config`,
  checkpoints: (pid: string)              => `fs:${pid}:checkpoints`,
  output:      (pid: string, f: string)   => `fs:${pid}:output:${f}`,
  outputIndex: (pid: string)              => `fs:${pid}:output_files`,
}

const _redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})
function getRedis(): Redis { return _redis }

// Upstash may return list items as already-parsed objects or raw strings.
// This helper handles both cases.
function parseItem<T>(item: unknown): T | null {
  if (item === null || item === undefined) return null
  if (typeof item === 'string') {
    try { return JSON.parse(item) as T } catch { return null }
  }
  return item as T
}

// ─── Kept for backward compat (path helpers no longer meaningful) ─────────────

export function projectDir(_id: string): string { return '' }
export const ensureProjectDir = async (_id: string) => {}

// ─── Project init (no-op — Redis needs no directory creation) ────────────────

export async function initProject(_projectId: string): Promise<void> {}

// ─── Default memory structure ─────────────────────────────────────────────────

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

// ─── memory.json → Redis string ───────────────────────────────────────────────

export async function readMemory(projectId: string): Promise<ProjectMemory> {
  try {
    const raw = await getRedis().get<unknown>(KEY.memory(projectId))
    return parseItem<ProjectMemory>(raw) ?? defaultMemory()
  } catch {
    return defaultMemory()
  }
}

export async function writeMemory(projectId: string, memory: ProjectMemory): Promise<void> {
  try {
    await getRedis().set(KEY.memory(projectId), JSON.stringify(memory), { ex: TTL_DATA })
  } catch { /* best-effort */ }
}

// ─── session_log.jsonl → Redis list ──────────────────────────────────────────

export async function appendSessionLog(projectId: string, event: ConversationEvent): Promise<void> {
  try {
    const redis = getRedis()
    await redis.rpush(KEY.sessionLog(projectId), JSON.stringify(event))
    // Trim the list so it never grows unbounded
    await redis.ltrim(KEY.sessionLog(projectId), -MAX_LOG_ENTRIES, -1)
    await redis.expire(KEY.sessionLog(projectId), TTL_LOG)
  } catch { /* best-effort */ }
}

export async function readRecentSessionLog(
  projectId: string,
  maxTokens = MAX_LOG_TOKENS,
): Promise<ConversationEvent[]> {
  try {
    const redis = getRedis()
    // Read the tail of the list, then trim to token budget
    const raw = await redis.lrange(KEY.sessionLog(projectId), -2000, -1)
    if (!raw || raw.length === 0) return []

    const events: ConversationEvent[] = []
    let charCount = 0
    const maxChars = maxTokens * CHARS_PER_TOKEN

    for (let i = raw.length - 1; i >= 0; i--) {
      const item = raw[i]
      const line = typeof item === 'string' ? item : JSON.stringify(item)
      charCount += line.length
      if (charCount > maxChars) break
      const parsed = parseItem<ConversationEvent>(item)
      if (parsed) events.unshift(parsed)
    }

    return events
  } catch {
    return []
  }
}

export async function readFullSessionLog(projectId: string): Promise<ConversationEvent[]> {
  try {
    const raw = await getRedis().lrange(KEY.sessionLog(projectId), 0, -1)
    if (!raw) return []
    return raw.flatMap(item => {
      const parsed = parseItem<ConversationEvent>(item)
      return parsed ? [parsed] : []
    })
  } catch {
    return []
  }
}

// ─── spec.json → Redis string (write-once guard preserved) ───────────────────

export async function writeSpec(projectId: string, spec: SpecDocument): Promise<void> {
  try {
    const redis = getRedis()
    const exists = await redis.exists(KEY.spec(projectId))
    if (exists) {
      throw new Error(`spec already exists for project ${projectId}. The spec cannot be overwritten.`)
    }
    await redis.set(KEY.spec(projectId), JSON.stringify(spec), { ex: TTL_DATA })
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) throw err
    // Swallow all other errors (best-effort)
  }
}

export async function readSpec(projectId: string): Promise<SpecDocument | null> {
  try {
    const raw = await getRedis().get<unknown>(KEY.spec(projectId))
    return parseItem<SpecDocument>(raw)
  } catch {
    return null
  }
}

export async function specExists(projectId: string): Promise<boolean> {
  try {
    return (await getRedis().exists(KEY.spec(projectId))) > 0
  } catch {
    return false
  }
}

// ─── review_list.json → Redis list ───────────────────────────────────────────

export async function appendReviewList(projectId: string, flag: ReviewFlag): Promise<void> {
  try {
    const redis = getRedis()
    await redis.rpush(KEY.reviewList(projectId), JSON.stringify(flag))
    await redis.ltrim(KEY.reviewList(projectId), -MAX_REVIEW_ITEMS, -1)
    await redis.expire(KEY.reviewList(projectId), TTL_DATA)
  } catch { /* best-effort */ }
}

export async function readReviewList(projectId: string): Promise<ReviewFlag[]> {
  try {
    const raw = await getRedis().lrange(KEY.reviewList(projectId), 0, -1)
    if (!raw) return []
    return raw.flatMap(item => {
      const parsed = parseItem<ReviewFlag>(item)
      return parsed ? [parsed] : []
    })
  } catch {
    return []
  }
}

// ─── config.json → Redis string ──────────────────────────────────────────────

export async function readProjectConfig(projectId: string): Promise<Record<string, unknown>> {
  try {
    const raw = await getRedis().get<unknown>(KEY.config(projectId))
    return parseItem<Record<string, unknown>>(raw) ?? {}
  } catch {
    return {}
  }
}

export async function writeProjectConfig(projectId: string, config: Record<string, unknown>): Promise<void> {
  try {
    await getRedis().set(KEY.config(projectId), JSON.stringify(config), { ex: TTL_DATA })
  } catch { /* best-effort */ }
}

// ─── output/ → Redis strings + index set ─────────────────────────────────────

export async function writeOutput(projectId: string, filename: string, content: string): Promise<void> {
  try {
    const redis = getRedis()
    await redis.set(KEY.output(projectId, filename), content, { ex: TTL_DATA })
    await redis.sadd(KEY.outputIndex(projectId), filename)
    await redis.expire(KEY.outputIndex(projectId), TTL_DATA)
  } catch { /* best-effort */ }
}

export const writeOutputFile = writeOutput

export async function readOutputFile(projectId: string, filename: string): Promise<string> {
  const raw = await getRedis().get<unknown>(KEY.output(projectId, filename))
  if (raw === null || raw === undefined) throw new Error(`Output file not found: ${filename}`)
  return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

export async function listOutputFiles(projectId: string): Promise<string[]> {
  try {
    const members = await getRedis().smembers<string[]>(KEY.outputIndex(projectId))
    return members ?? []
  } catch {
    return []
  }
}

// ─── checkpoints/ → Redis list ───────────────────────────────────────────────

export interface CheckpointData {
  id:             string
  trigger:        string
  summary:        string
  timestamp:      number
  outputSnapshot: Record<string, string>
  memory:         ProjectMemory
}

export async function saveCheckpoint(
  projectId: string,
  trigger:   'module_complete' | 'conflict_resolved' | 'human_confirm' | 'manual',
  summary:   string,
  outputSnapshot: Record<string, string> = {},
): Promise<string> {
  const id = `${Date.now()}_${trigger}`
  try {
    const redis    = getRedis()
    const memory   = await readMemory(projectId)
    const payload: CheckpointData = { id, trigger, summary, timestamp: Date.now(), outputSnapshot, memory }
    await redis.rpush(KEY.checkpoints(projectId), JSON.stringify(payload))
    await redis.ltrim(KEY.checkpoints(projectId), -MAX_CHECKPOINTS, -1)
    await redis.expire(KEY.checkpoints(projectId), TTL_DATA)
  } catch { /* best-effort */ }
  return id
}

export async function listCheckpoints(
  projectId: string,
): Promise<Array<Pick<CheckpointData, 'id' | 'trigger' | 'timestamp' | 'summary'>>> {
  try {
    const raw = await getRedis().lrange(KEY.checkpoints(projectId), 0, -1)
    if (!raw) return []
    return raw
      .flatMap(item => {
        const parsed = parseItem<CheckpointData>(item)
        return parsed ? [{ id: parsed.id, trigger: parsed.trigger, timestamp: parsed.timestamp, summary: parsed.summary }] : []
      })
      .sort((a, b) => b.timestamp - a.timestamp)
  } catch {
    return []
  }
}

// ─── Token estimation — re-exported from canonical location ──────────────────
export { estimateTokens } from '@/lib/utils/tokens'
