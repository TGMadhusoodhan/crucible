import fs   from 'fs'
import { estimateTokens } from '@/lib/utils/tokens'
import { buildSignatureBlock } from '@/lib/workspace/indexer'
import { resolveInWorkspace }  from '@/lib/workspace/paths'
import type { FileDefinition, FileManifest, RegistryEntry } from '@/types'

// ─── Budget caps ──────────────────────────────────────────────────────────────

const TIER1_TOKEN_CAP = 12_000   // direct-dep full source
const TIER2_TOKEN_CAP =  6_000   // other known files — signature blocks

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GenerationContext {
  tier1Text:      string   // direct dep full sources (full code or sig block if demoted)
  tier2Text:      string   // all other known files — signature blocks
  tier3Text:      string   // manifest-only ungenerated files — one-line purposes
  compositionLog: string   // for session log: tier sizes + demotion/omission counts
  tier1Tokens:    number
  tier2Tokens:    number
  tier3Tokens:    number
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function sigBlockForFile(
  filename:     string,
  registry:     RegistryEntry[],
  acceptedFiles: Record<string, string>,
): string {
  const entry = registry.find(e => e.filename === filename)
  if (entry?.signatureBlock) return entry.signatureBlock
  // Build on-the-fly from this-session accepted code (no registry entry yet)
  const code = acceptedFiles[filename]
  if (code) return buildSignatureBlock(filename, code)
  return `## ${filename}\n(signature unavailable)`
}

function readFileSafe(workspaceDir: string, filename: string): string | null {
  try {
    const full = resolveInWorkspace(workspaceDir, filename)
    return fs.readFileSync(full, 'utf8')
  } catch { return null }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Build a three-tier generation context for one file in the pipeline.
 *
 * Tier 1 — direct deps (full source, 12k token cap; demotes largest to sig if over)
 * Tier 2 — all other known project files (sig blocks, 6k token cap; omits largest if over)
 * Tier 3 — manifest files not yet generated (one-line purpose + exports)
 *
 * Call site: BaseAdapter.generate() — replaces hand-rolled depContext.
 */
export function buildGenerationContext(
  filename:      string,
  fileDef:       FileDefinition,
  manifest:      FileManifest,
  registry:      RegistryEntry[],
  acceptedFiles: Record<string, string>,
  workspaceDir?: string,
): GenerationContext {
  const directDeps = new Set(Object.keys(fileDef.imports))

  // ── Tier 1: direct dependencies — full source ─────────────────────────────

  // Collect in manifest generation order (preserves cache-prefix stability)
  type T1Item = { filename: string; code: string; demoted: boolean }
  const tier1Items: T1Item[] = []

  for (const f of manifest.files) {
    if (f.filename === filename || !directDeps.has(f.filename)) continue
    const code = acceptedFiles[f.filename]
      ?? (workspaceDir ? readFileSafe(workspaceDir, f.filename) : null)
    if (code !== null) tier1Items.push({ filename: f.filename, code, demoted: false })
  }

  // Token budget — demote largest-first until under cap
  const tokensFor = (item: T1Item): number =>
    estimateTokens(`// === ${item.filename} (full code) ===\n${item.code}`)

  let t1Tokens = tier1Items.reduce((s, i) => s + tokensFor(i), 0)
  const demoted: string[] = []
  while (t1Tokens > TIER1_TOKEN_CAP && tier1Items.some(i => !i.demoted)) {
    let maxIdx = 0
    for (let i = 1; i < tier1Items.length; i++) {
      if (!tier1Items[i]!.demoted && (tier1Items[maxIdx]!.demoted || tier1Items[i]!.code.length > tier1Items[maxIdx]!.code.length)) {
        maxIdx = i
      }
    }
    tier1Items[maxIdx]!.demoted = true
    demoted.push(tier1Items[maxIdx]!.filename)
    t1Tokens = tier1Items.reduce((s, i) => s + (i.demoted ? 0 : tokensFor(i)), 0)
  }

  const tier1Parts: string[] = []
  for (const item of tier1Items) {
    if (!item.demoted) {
      tier1Parts.push(`// === ${item.filename} (full code) ===\n${item.code}`)
    } else {
      const sig = sigBlockForFile(item.filename, registry, acceptedFiles)
      tier1Parts.push(
        `// === ${item.filename} (full source omitted for size; signatures below are authoritative) ===\n${sig}`,
      )
    }
  }
  const tier1Tokens = tier1Parts.reduce((s, p) => s + estimateTokens(p), 0)

  // ── Tier 2: all other known files — signature blocks ─────────────────────

  const knownFiles = new Set([
    ...Object.keys(acceptedFiles),
    ...registry.map(e => e.filename),
  ])

  type T2Item = { filename: string; sig: string }
  const tier2Items: T2Item[] = []

  // Manifest files (except current + direct deps + ungenerated)
  for (const f of manifest.files) {
    if (f.filename === filename) continue
    if (directDeps.has(f.filename)) continue
    if (!knownFiles.has(f.filename)) continue  // ungenerated → tier 3
    tier2Items.push({ filename: f.filename, sig: sigBlockForFile(f.filename, registry, acceptedFiles) })
  }

  // Prior-session registry files not in this manifest
  const manifestFiles = new Set(manifest.files.map(f => f.filename))
  for (const entry of registry) {
    if (entry.filename === filename) continue
    if (directDeps.has(entry.filename)) continue
    if (manifestFiles.has(entry.filename)) continue  // already handled above
    if (entry.signatureBlock) tier2Items.push({ filename: entry.filename, sig: entry.signatureBlock })
  }

  // Token budget — omit largest-first until under cap
  let t2Tokens = tier2Items.reduce((s, i) => s + estimateTokens(i.sig + '\n'), 0)
  const omitted: string[] = []
  while (t2Tokens > TIER2_TOKEN_CAP && tier2Items.length > 0) {
    let maxIdx = 0
    for (let i = 1; i < tier2Items.length; i++) {
      if (tier2Items[i]!.sig.length > tier2Items[maxIdx]!.sig.length) maxIdx = i
    }
    omitted.push(tier2Items.splice(maxIdx, 1)[0]!.filename)
    t2Tokens = tier2Items.reduce((s, i) => s + estimateTokens(i.sig + '\n'), 0)
  }

  const tier2Parts = tier2Items.map(i => i.sig)
  if (omitted.length > 0) {
    tier2Parts.push(`// [${omitted.length} additional file${omitted.length > 1 ? 's' : ''} omitted for context budget]`)
  }
  const tier2Tokens = tier2Parts.reduce((s, p) => s + estimateTokens(p + '\n'), 0)

  // ── Tier 3: ungenerated files — one-line purposes ─────────────────────────

  const tier3Parts: string[] = []
  for (const f of manifest.files) {
    if (f.filename === filename) continue
    if (directDeps.has(f.filename)) continue
    if (knownFiles.has(f.filename)) continue
    const exps = f.exports.length > 0 ? ` (exports: ${f.exports.join(', ')})` : ''
    tier3Parts.push(`// ${f.filename}: ${f.purpose}${exps}`)
  }
  const tier3Text   = tier3Parts.join('\n')
  const tier3Tokens = estimateTokens(tier3Text)

  const compositionLog = [
    `T1=${tier1Tokens}tok/${tier1Items.length}files`,
    demoted.length  ? `(${demoted.length} demoted)` : null,
    `T2=${tier2Tokens}tok/${tier2Items.length}sigs`,
    omitted.length  ? `(${omitted.length} omitted)` : null,
    `T3=${tier3Tokens}tok/${tier3Parts.length}pending`,
  ].filter(Boolean).join(' ')

  return {
    tier1Text:   tier1Parts.join('\n\n'),
    tier2Text:   tier2Parts.join('\n\n'),
    tier3Text,
    compositionLog,
    tier1Tokens,
    tier2Tokens,
    tier3Tokens,
  }
}

// ─── Reviewer direct-dep signatures ──────────────────────────────────────────
// Returns signature blocks for a file's direct dependencies, so reviewers can
// catch cross-file contract violations (the bug class single models miss).

export function buildReviewerDepContext(
  fileDef:       FileDefinition,
  registry:      RegistryEntry[],
  acceptedFiles: Record<string, string>,
): string {
  const sigs: string[] = []
  for (const depFile of Object.keys(fileDef.imports)) {
    const sig = sigBlockForFile(depFile, registry, acceptedFiles)
    if (!sig.includes('(signature unavailable)')) sigs.push(sig)
  }
  return sigs.join('\n\n')
}
