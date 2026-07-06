import { generateId } from '@/lib/utils'
import type {
  AcceptanceCriterion,
  EdgeCase,
  FileDefinition,
  FileManifest,
  ModelAdapter,
  Question,
  SpecDocument,
  SSEEvent,
} from '@/types'

// ─── Spec merge (R1 + R2 jointly propose, then reconciled here) ──────────────

// model_defaults values are JSON-encoded arrays (see buildSpecDocument in
// base.ts) rather than joined with a plain separator — that avoids a model
// string containing the separator itself silently corrupting the split.
function splitDefault(value: string | undefined): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function joinDefaults(values: string[]): string {
  // Empty string (not "[]") so setIfNonEmpty's truthy check still treats an
  // empty merge result as "nothing to set" instead of always setting the key.
  return values.length > 0 ? JSON.stringify(values) : ''
}

function unionDefaults(a: string | undefined, b: string | undefined): string {
  return joinDefaults([...new Set([...splitDefault(a), ...splitDefault(b)])])
}

function intersectDefaults(a: string | undefined, b: string | undefined): string {
  const setB = new Set(splitDefault(b))
  return joinDefaults(splitDefault(a).filter(v => setB.has(v)))
}

function mergeModelDefaults(
  r1: Record<string, string>,
  r2: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {}
  const setIfNonEmpty = (key: string, value: string) => { if (value) merged[key] = value }

  // tech_stack: r1 as base per architecture decision — R1 is the first-among-equals
  // proposer, R2's spec+manifest exists mainly to catch what R1 missed.
  setIfNonEmpty('tech_stack',   r1.tech_stack || r2.tech_stack || '')
  setIfNonEmpty('requirements', unionDefaults(r1.requirements, r2.requirements))
  setIfNonEmpty('constraints',  unionDefaults(r1.constraints, r2.constraints))
  setIfNonEmpty('out_of_scope', intersectDefaults(r1.out_of_scope, r2.out_of_scope))
  return merged
}

function mergeAcceptanceCriteria(a: AcceptanceCriterion[], b: AcceptanceCriterion[]): AcceptanceCriterion[] {
  const seen = new Set<string>()
  const merged: AcceptanceCriterion[] = []
  for (const c of [...a, ...b]) {
    const key = c.description.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(c)
  }
  // R1 and R2 each ID their own criteria independently (ac_1, ac_2, ...), so
  // merging two non-overlapping lists produces duplicate ids — reassign fresh
  // sequential ones so React keys (and anything else keying off id) stay unique.
  return merged.map((c, i) => ({ ...c, id: `ac_${i + 1}` }))
}

function mergeEdgeCases(a: EdgeCase[], b: EdgeCase[]): EdgeCase[] {
  const seen = new Set<string>()
  const merged: EdgeCase[] = []
  for (const c of [...a, ...b]) {
    const key = c.scenario.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(c)
  }
  return merged.map((c, i) => ({ ...c, id: `ec_${i + 1}` }))
}

function mergeSpecs(
  r1:              SpecDocument,
  r2:              SpecDocument,
  projectId:       string,
  sessionId:       string,
  taskDescription: string,
  answers:         Record<string, string>,
): SpecDocument {
  return {
    id:                  generateId(),
    project_id:          projectId,
    session_id:          sessionId,
    created_at:          new Date().toISOString(),
    task_description:    r1.task_description || taskDescription,
    codebase_context:    r1.codebase_context ?? r2.codebase_context,
    user_decisions:      answers,
    model_defaults:      mergeModelDefaults(r1.model_defaults, r2.model_defaults),
    acceptance_criteria: mergeAcceptanceCriteria(r1.acceptance_criteria, r2.acceptance_criteria),
    edge_cases:          mergeEdgeCases(r1.edge_cases, r2.edge_cases),
    error_messages:      r1.error_messages.length > 0 ? r1.error_messages : r2.error_messages,
    human_confirmed:     false,
  }
}

// ─── Manifest merge (union of files — same-name conflicts flagged, R1 wins) ──

function structuresDiffer(a: FileDefinition, b: FileDefinition): boolean {
  return (
    a.purpose !== b.purpose ||
    JSON.stringify([...a.exports].sort()) !== JSON.stringify([...b.exports].sort()) ||
    JSON.stringify(a.imports) !== JSON.stringify(b.imports)
  )
}

function basename(filepath: string): string {
  return filepath.split('/').pop() ?? filepath
}

function mergeManifests(r1: FileManifest, r2: FileManifest): FileManifest {
  const byFilename = new Map<string, FileDefinition>()
  const byBasename  = new Map<string, string>()   // basename → canonical filename
  const canonicalize = new Map<string, string>()  // any filename seen → canonical filename
  const conflicts: string[] = []

  for (const f of r1.files) {
    byFilename.set(f.filename, f)
    byBasename.set(basename(f.filename), f.filename)
    canonicalize.set(f.filename, f.filename)
  }

  for (const f of r2.files) {
    // R1 and R2 sometimes propose the same file under different paths (e.g.
    // "lru-cache.ts" vs "src/lru-cache.ts") — matching on exact filename alone
    // would let both through as separate files. Fall back to basename matching
    // so these collapse into one, using R1's path as canonical.
    const canonicalName = byFilename.has(f.filename)
      ? f.filename
      : byBasename.get(basename(f.filename)) ?? f.filename
    canonicalize.set(f.filename, canonicalName)

    const existing = byFilename.get(canonicalName)
    if (!existing) {
      byFilename.set(canonicalName, f)
      byBasename.set(basename(canonicalName), canonicalName)
      continue
    }
    // Same file in both manifests — pick R1's definition, flag if they disagree
    // on path or structure so the human sees it at the phase2_confirm gate.
    if (canonicalName !== f.filename) {
      conflicts.push(`${f.filename} (same file as ${canonicalName} — using ${canonicalName}'s path)`)
    } else if (structuresDiffer(existing, f)) {
      conflicts.push(f.filename)
    }
  }

  const files = [...byFilename.values()]

  const order: string[] = []
  for (const filename of r1.generation_order) {
    if (!order.includes(filename)) order.push(filename)
  }
  for (const filename of r2.generation_order) {
    const canonicalName = canonicalize.get(filename) ?? filename
    if (!order.includes(canonicalName)) order.push(canonicalName)
  }
  for (const f of files) {
    if (!order.includes(f.filename)) order.push(f.filename)
  }

  const reasoning = conflicts.length > 0
    ? `${r1.reasoning}\n\nMerged with R2's manifest. Structural conflicts on: ${conflicts.join(', ')} — using R1's definition. Review before confirming.`
    : `${r1.reasoning}\n\nMerged with R2's manifest — no structural conflicts.`

  return {
    mode:             files.length > 1 ? 'multi' : 'single',
    files,
    generation_order: order,
    reasoning,
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Phase 2 — R1 and R2 independently propose a spec + file manifest, then this
 * reconciles them into one: union of requirements/constraints/edge_cases,
 * intersection of out_of_scope, R1's tech_stack as base. Manifests are unioned
 * by filename; a same-name file with a different structure keeps R1's
 * definition but is flagged in the manifest's reasoning for human review at
 * the phase2_confirm gate.
 */
export async function runPhase2SpecAndManifest(
  projectId:       string,
  sessionId:       string,
  taskDescription: string,
  questions:       Question[],
  answers:         Record<string, string>,
  r1Adapter:       ModelAdapter,
  r2Adapter:       ModelAdapter,
  emit:            (e: SSEEvent) => void,
  contextText?:    string,
): Promise<{ spec: SpecDocument; manifest: FileManifest }> {
  emit({ type: 'phase_change', phase: 'phase2_spec_and_manifest' })

  const [r1Result, r2Result] = await Promise.all([
    r1Adapter.proposeSpecAndManifest(taskDescription, questions, answers, contextText),
    r2Adapter.proposeSpecAndManifest(taskDescription, questions, answers, contextText),
  ])

  const spec     = mergeSpecs(r1Result.spec, r2Result.spec, projectId, sessionId, taskDescription, answers)
  const manifest = mergeManifests(r1Result.manifest, r2Result.manifest)

  emit({ type: 'spec_ready', spec })
  emit({ type: 'manifest_ready', manifest })

  return { spec, manifest }
}
