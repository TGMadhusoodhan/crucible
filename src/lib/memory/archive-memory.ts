import type { CompletedModule, ProjectMemory } from '@/types'
import { estimateTokens } from './filesystem'

// Compression triggers (from CLAUDE.md):
//   Module marked complete → compress to interface description only
//   Conflict resolved → compress to "Decision: X because Y"
//   Code version superseded → drop old version, keep final only
//   Active memory exceeds 8k tokens → move oldest decisions to archive

// ─── Archive a completed module ───────────────────────────────────────────────

export function archiveModule(
  memory: ProjectMemory,
  moduleName: string,
  interfaceDescription: string,
): ProjectMemory {
  const completed: CompletedModule = {
    name:                 moduleName,
    description:          `Completed module: ${moduleName}`,
    completedAt:          Date.now(),
    interfaceDescription,
  }

  // Remove from active open_questions anything related to this module
  const filteredQuestions = memory.active.open_questions.filter(
    q => !q.toLowerCase().includes(moduleName.toLowerCase())
  )

  return {
    active: {
      ...memory.active,
      current_module:  '',
      open_questions:  filteredQuestions,
    },
    archive: {
      ...memory.archive,
      completed_modules: [...memory.archive.completed_modules, completed],
    },
  }
}

// ─── Deprecate an old approach ────────────────────────────────────────────────

export function markDeprecated(memory: ProjectMemory, approach: string): ProjectMemory {
  if (memory.archive.deprecated_approaches.includes(approach)) return memory
  return {
    ...memory,
    archive: {
      ...memory.archive,
      deprecated_approaches: [...memory.archive.deprecated_approaches, approach],
    },
  }
}

// ─── Archive old architecture notes ──────────────────────────────────────────

export function addArchitectureNote(memory: ProjectMemory, note: string): ProjectMemory {
  return {
    ...memory,
    archive: {
      ...memory.archive,
      earlier_architecture: [...memory.archive.earlier_architecture, note],
    },
  }
}

// ─── Serialise archive for on-demand injection ────────────────────────────────
// Archive is NOT injected every session — only when the pipeline explicitly
// requests it (e.g., when the model needs context about a completed module).

export function serializeArchiveSection(
  memory: ProjectMemory,
  sections: ('modules' | 'decisions' | 'architecture' | 'deprecated')[],
): string {
  const parts: string[] = ['[ARCHIVE MEMORY — on demand only]']

  if (sections.includes('modules') && memory.archive.completed_modules.length) {
    parts.push(
      'Completed modules:',
      ...memory.archive.completed_modules.map(m =>
        `  • ${m.name}: ${m.interfaceDescription}`
      ),
    )
  }

  if (sections.includes('decisions') && memory.archive.resolved_decisions.length) {
    parts.push(
      'Resolved decisions:',
      ...memory.archive.resolved_decisions.slice(-10).map(d =>
        `  • ${d.description}: ${d.reason}`
      ),
    )
  }

  if (sections.includes('architecture') && memory.archive.earlier_architecture.length) {
    parts.push(
      'Earlier architecture notes:',
      ...memory.archive.earlier_architecture.map(a => `  • ${a}`),
    )
  }

  if (sections.includes('deprecated') && memory.archive.deprecated_approaches.length) {
    parts.push(
      'Deprecated approaches (do not use):',
      ...memory.archive.deprecated_approaches.map(a => `  • ${a}`),
    )
  }

  return parts.join('\n')
}

export function estimateArchiveTokens(memory: ProjectMemory): number {
  return estimateTokens(JSON.stringify(memory.archive))
}
