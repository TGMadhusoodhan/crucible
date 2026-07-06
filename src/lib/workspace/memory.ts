import crypto        from 'crypto'
import { execFile }  from 'child_process'
import fs            from 'fs'
import path          from 'path'
import { promisify } from 'util'
import { resolveInWorkspace } from './paths'
import type {
  CrucibleDecision,
  FileManifest,
  HistoryEvent,
  ProjectContext,
  RegistryEntry,
  SpecDocument,
} from '@/types'

const execFileAsync = promisify(execFile)

// ─── Constants ────────────────────────────────────────────────────────────────

const CRUCIBLE_DIR = '.crucible'

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.crucible'])
const IGNORE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.mp3', '.zip', '.tar', '.gz', '.bin',
])

// ─── Git helper ───────────────────────────────────────────────────────────────

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT:  '0',
  GIT_AUTHOR_NAME:      'Crucible',
  GIT_AUTHOR_EMAIL:     'crucible@localhost',
  GIT_COMMITTER_NAME:   'Crucible',
  GIT_COMMITTER_EMAIL:  'crucible@localhost',
}

export async function commitCrucibleFiles(workspaceDir: string, message: string): Promise<void> {
  try {
    await execFileAsync('git', [
      'add', '--',
      path.join(CRUCIBLE_DIR, 'project.json'),
      path.join(CRUCIBLE_DIR, 'registry.json'),
      path.join(CRUCIBLE_DIR, 'history.jsonl'),
      'CRUCIBLE.md',
    ], { cwd: workspaceDir, timeout: 10_000, env: GIT_ENV })
    await execFileAsync('git', ['commit', '-m', message],
      { cwd: workspaceDir, timeout: 10_000, env: GIT_ENV })
  } catch { /* git unavailable or nothing to commit — non-fatal */ }
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface ProjectJson {
  spec:      SpecDocument | null
  manifest:  FileManifest | null
  decisions: CrucibleDecision[]
  createdAt: string    // ISO8601
  updatedAt: string    // ISO8601
}

// ─── ProjectJson ──────────────────────────────────────────────────────────────

export function readProjectJson(workspaceDir: string): ProjectJson | null {
  try {
    const file = path.join(workspaceDir, CRUCIBLE_DIR, 'project.json')
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectJson
  } catch { return null }
}

function writeProjectJson(workspaceDir: string, data: ProjectJson): void {
  fs.mkdirSync(path.join(workspaceDir, CRUCIBLE_DIR), { recursive: true })
  fs.writeFileSync(path.join(workspaceDir, CRUCIBLE_DIR, 'project.json'), JSON.stringify(data, null, 2))
}

export function updateProjectSpec(workspaceDir: string, spec: SpecDocument, manifest: FileManifest): void {
  const existing = readProjectJson(workspaceDir)
  const now = new Date().toISOString()
  writeProjectJson(workspaceDir, {
    spec,
    manifest,
    decisions: existing?.decisions ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
}

export function addDecision(workspaceDir: string, decision: CrucibleDecision): void {
  const existing = readProjectJson(workspaceDir)
  const now = new Date().toISOString()
  writeProjectJson(workspaceDir, {
    spec:      existing?.spec     ?? null,
    manifest:  existing?.manifest ?? null,
    decisions: [...(existing?.decisions ?? []), decision],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
}

export function batchAddDecisions(workspaceDir: string, decisions: CrucibleDecision[]): void {
  if (decisions.length === 0) return
  const existing = readProjectJson(workspaceDir)
  const now = new Date().toISOString()
  writeProjectJson(workspaceDir, {
    spec:      existing?.spec     ?? null,
    manifest:  existing?.manifest ?? null,
    decisions: [...(existing?.decisions ?? []), ...decisions],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export function readRegistry(workspaceDir: string): RegistryEntry[] {
  try {
    const file = path.join(workspaceDir, CRUCIBLE_DIR, 'registry.json')
    if (!fs.existsSync(file)) return []
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RegistryEntry[]
  } catch { return [] }
}

export function writeRegistry(workspaceDir: string, entries: RegistryEntry[]): void {
  fs.mkdirSync(path.join(workspaceDir, CRUCIBLE_DIR), { recursive: true })
  fs.writeFileSync(path.join(workspaceDir, CRUCIBLE_DIR, 'registry.json'), JSON.stringify(entries, null, 2))
}

export function updateRegistryEntry(workspaceDir: string, entry: RegistryEntry): void {
  const registry = readRegistry(workspaceDir)
  const idx      = registry.findIndex(e => e.filename === entry.filename)
  if (idx === -1) registry.push(entry)
  else            registry[idx] = entry
  writeRegistry(workspaceDir, registry)
}

// ─── History ──────────────────────────────────────────────────────────────────

export function appendHistory(workspaceDir: string, event: HistoryEvent): void {
  try {
    fs.mkdirSync(path.join(workspaceDir, CRUCIBLE_DIR), { recursive: true })
    fs.appendFileSync(
      path.join(workspaceDir, CRUCIBLE_DIR, 'history.jsonl'),
      JSON.stringify(event) + '\n',
    )
  } catch { /* non-fatal */ }
}

// ─── Content hashing ──────────────────────────────────────────────────────────

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

// ─── Heuristic export scanner ─────────────────────────────────────────────────
// Used during drift re-indexing until a proper AST indexer is available.

export function extractExports(code: string, filename: string): string[] {
  const ext = path.extname(filename)
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return []
  const exports: string[] = []
  const namedRe = /^export\s+(?:default\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+(\w+)/gm
  const braceRe = /^export\s*\{([^}]+)\}/gm
  let m: RegExpExecArray | null
  while ((m = namedRe.exec(code)) !== null) {
    if (m[1] && !exports.includes(m[1])) exports.push(m[1])
  }
  while ((m = braceRe.exec(code)) !== null) {
    const names = m[1]!.split(',')
      .map(s => s.trim().split(/\s+as\s+/)[0]!.trim())
      .filter(Boolean)
    for (const n of names) if (n && !exports.includes(n)) exports.push(n)
  }
  return exports.slice(0, 20)
}

// ─── CRUCIBLE.md management ───────────────────────────────────────────────────

function readCrucibleMd(workspaceDir: string): string {
  try {
    const file = path.join(workspaceDir, 'CRUCIBLE.md')
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  } catch { return '' }
}

function replaceSection(md: string, section: string, content: string): string {
  const start = `<!-- crucible:${section}:start -->`
  const end   = `<!-- crucible:${section}:end -->`
  const si    = md.indexOf(start)
  const ei    = md.indexOf(end)
  if (si !== -1 && ei !== -1 && si < ei) {
    return md.slice(0, si + start.length) + '\n' + content + '\n' + md.slice(ei)
  }
  return md + '\n\n' + start + '\n' + content + '\n' + end + '\n'
}

function buildOverview(spec: SpecDocument | null): string {
  if (!spec) return '_No spec generated yet._'
  const desc = spec.task_description.length > 300
    ? spec.task_description.slice(0, 300) + '…'
    : spec.task_description
  const crit = spec.acceptance_criteria.slice(0, 3).map(c => `- ${c.description}`).join('\n')
  const more = spec.acceptance_criteria.length > 3 ? '\n- …' : ''
  return `${desc}\n\n**Acceptance criteria:**\n${crit}${more}`
}

function buildConventions(spec: SpecDocument | null): string {
  if (!spec) return '_No spec generated yet._'
  const items: string[] = []
  for (const [k, v] of Object.entries(spec.model_defaults)) {
    items.push(`- **${k}:** ${v}`)
  }
  if (spec.error_messages.length > 0) {
    items.push('', '**Error handling:**')
    for (const e of spec.error_messages.slice(0, 5)) {
      items.push(`- ${e.trigger}: ${e.message}`)
    }
  }
  return items.length > 0 ? items.join('\n') : '_No explicit conventions documented._'
}

function buildDecisionsSection(decisions: CrucibleDecision[]): string {
  if (decisions.length === 0) return '_No decisions recorded yet._'
  return decisions.map(d => {
    const date = d.timestamp.slice(0, 10)
    const icon = d.source === 'human' ? '👤' : d.source === 'arbitration' ? '⚖️' : '🤖'
    const q    = d.questionText.length > 80 ? d.questionText.slice(0, 80) + '…' : d.questionText
    return `- ${date} ${icon} **${q}** → ${d.answer}`
  }).join('\n')
}

function buildFilesSection(entries: RegistryEntry[]): string {
  if (entries.length === 0) return '_No files accepted yet._'
  const header = '| File | Purpose | Key Exports |'
  const sep    = '|------|---------|-------------|'
  const rows   = entries.map(e => {
    const exps    = e.exports.length > 0 ? e.exports.slice(0, 4).join(', ') : '—'
    const purpose = e.summary.length > 60 ? e.summary.slice(0, 60) + '…' : e.summary
    return `| \`${e.filename}\` | ${purpose} | ${exps} |`
  })
  return [header, sep, ...rows].join('\n')
}

export function updateCrucibleMd(workspaceDir: string, projectName: string): void {
  const projectJson = readProjectJson(workspaceDir)
  const registry    = readRegistry(workspaceDir)
  const existing    = readCrucibleMd(workspaceDir)

  const blank = [
    `# ${projectName}`,
    '',
    '_Managed by Crucible. Content outside the managed sections is yours to edit freely._',
    '',
    '## Overview',
    '',
    '<!-- crucible:overview:start -->',
    '_No spec generated yet._',
    '<!-- crucible:overview:end -->',
    '',
    '## Conventions',
    '',
    '<!-- crucible:conventions:start -->',
    '_No spec generated yet._',
    '<!-- crucible:conventions:end -->',
    '',
    '## Decisions',
    '',
    '<!-- crucible:decisions:start -->',
    '_No decisions recorded yet._',
    '<!-- crucible:decisions:end -->',
    '',
    '## Files',
    '',
    '<!-- crucible:files:start -->',
    '_No files accepted yet._',
    '<!-- crucible:files:end -->',
    '',
  ].join('\n')

  let md = existing || blank
  md = replaceSection(md, 'overview',    buildOverview(projectJson?.spec ?? null))
  md = replaceSection(md, 'conventions', buildConventions(projectJson?.spec ?? null))
  md = replaceSection(md, 'decisions',   buildDecisionsSection(projectJson?.decisions ?? []))
  md = replaceSection(md, 'files',       buildFilesSection(registry))

  fs.writeFileSync(path.join(workspaceDir, 'CRUCIBLE.md'), md)
}

// ─── Workspace source file listing ───────────────────────────────────────────

function listSourceFiles(dir: string, base: string): string[] {
  const results: string[] = []
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...listSourceFiles(full, base))
      } else if (!IGNORE_EXTS.has(path.extname(entry.name))) {
        results.push(path.relative(base, full))
      }
    }
  } catch { /* skip unreadable */ }
  return results
}

// ─── loadProjectContext ───────────────────────────────────────────────────────

export function loadProjectContext(workspaceDir: string): ProjectContext {
  const projectJson = readProjectJson(workspaceDir)
  const registry    = readRegistry(workspaceDir)
  const crucibleMd  = readCrucibleMd(workspaceDir) || null

  if (!projectJson) {
    return {
      specSummary:    '',
      decisions:      [],
      fileIndex:      registry,
      driftedFiles:   [],
      untrackedFiles: listSourceFiles(workspaceDir, workspaceDir),
      crucibleMd,
      mode: 'new',
    }
  }

  // Drift detection: compare each registered file against its stored sha256
  const driftedFiles:   string[] = []
  const updatedRegistry = registry.map(e => ({ ...e }))

  for (let i = 0; i < updatedRegistry.length; i++) {
    const entry = updatedRegistry[i]!
    let fullPath: string
    try { fullPath = resolveInWorkspace(workspaceDir, entry.filename) } catch { continue }
    if (!fs.existsSync(fullPath)) continue
    try {
      const content     = fs.readFileSync(fullPath, 'utf8')
      const currentHash = hashContent(content)
      if (currentHash !== entry.sha256) {
        driftedFiles.push(entry.filename)
        updatedRegistry[i] = {
          ...entry,
          sha256:  currentHash,
          exports: extractExports(content, entry.filename),
        }
      }
    } catch { /* skip unreadable */ }
  }

  if (driftedFiles.length > 0) {
    writeRegistry(workspaceDir, updatedRegistry)
  }

  const registeredSet  = new Set(updatedRegistry.map(e => e.filename))
  const untrackedFiles = listSourceFiles(workspaceDir, workspaceDir).filter(f => !registeredSet.has(f))

  const spec       = projectJson.spec
  const specSummary = spec
    ? (spec.task_description.length > 200
        ? spec.task_description.slice(0, 200) + '…'
        : spec.task_description)
    : ''

  return {
    specSummary,
    decisions:     projectJson.decisions,
    fileIndex:     updatedRegistry,
    driftedFiles,
    untrackedFiles,
    crucibleMd,
    mode: specSummary ? 'continue' : 'new',
  }
}
