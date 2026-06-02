import { generateId } from '@/lib/utils'
import type { Conflict, Decision, ProjectMemory } from '@/types'
import { estimateTokens } from './filesystem'

// Active memory must stay under 8k tokens — anything over triggers compression.
const ACTIVE_MEMORY_TOKEN_LIMIT = 8_000
const MAX_RECENT_DECISIONS      = 10

// ─── Token estimation ─────────────────────────────────────────────────────────

export function estimateActiveMemoryTokens(memory: ProjectMemory): number {
  return estimateTokens(JSON.stringify(memory.active))
}

export function needsCompression(memory: ProjectMemory): boolean {
  return estimateActiveMemoryTokens(memory) > ACTIVE_MEMORY_TOKEN_LIMIT
}

// ─── Serialise active memory to a prompt block ────────────────────────────────
// Used by the pipeline to inject active memory into every model call.

export function serializeActiveMemory(memory: ProjectMemory): string {
  const { active } = memory
  const parts: string[] = ['[ACTIVE MEMORY]']

  if (active.current_module) {
    parts.push(`Current module: ${active.current_module}`)
  }
  if (active.current_tech_stack.length) {
    parts.push(`Tech stack: ${active.current_tech_stack.join(', ')}`)
  }
  if (active.open_questions.length) {
    parts.push(`Open questions: ${active.open_questions.join(' | ')}`)
  }
  if (active.unresolved_conflicts.length) {
    parts.push(
      'Unresolved conflicts:',
      ...active.unresolved_conflicts.map(c =>
        `  • Primary: ${c.primaryPosition} | Reviewer: ${c.reviewerPosition}`
      ),
    )
  }
  if (active.recent_decisions.length) {
    parts.push(
      'Recent decisions:',
      ...active.recent_decisions.slice(-5).map(d => `  • ${d.description} — ${d.reason}`),
    )
  }

  return parts.join('\n')
}

// ─── Mutation helpers (return new ProjectMemory — never mutate in place) ──────

export function addDecision(memory: ProjectMemory, description: string, reason: string): ProjectMemory {
  const decision: Decision = { id: generateId(), description, reason, timestamp: Date.now() }
  const recent = [...memory.active.recent_decisions, decision]

  // If we've exceeded the limit, move oldest to archive
  if (recent.length > MAX_RECENT_DECISIONS) {
    const toArchive = recent.slice(0, recent.length - MAX_RECENT_DECISIONS)
    const kept      = recent.slice(recent.length - MAX_RECENT_DECISIONS)
    return {
      active:  { ...memory.active, recent_decisions: kept },
      archive: {
        ...memory.archive,
        resolved_decisions: [...memory.archive.resolved_decisions, ...toArchive],
      },
    }
  }

  return { ...memory, active: { ...memory.active, recent_decisions: recent } }
}

export function setCurrentModule(memory: ProjectMemory, moduleName: string): ProjectMemory {
  // If there was a previous module, move it to archive
  if (memory.active.current_module && memory.active.current_module !== moduleName) {
    const completed = {
      name:                 memory.active.current_module,
      description:          `Completed module`,
      completedAt:          Date.now(),
      interfaceDescription: `See session log for details`,
    }
    return {
      active: { ...memory.active, current_module: moduleName },
      archive: {
        ...memory.archive,
        completed_modules: [...memory.archive.completed_modules, completed],
      },
    }
  }
  return { ...memory, active: { ...memory.active, current_module: moduleName } }
}

export function setTechStack(memory: ProjectMemory, stack: string[]): ProjectMemory {
  return { ...memory, active: { ...memory.active, current_tech_stack: stack } }
}

export function addOpenQuestion(memory: ProjectMemory, question: string): ProjectMemory {
  if (memory.active.open_questions.includes(question)) return memory
  return { ...memory, active: { ...memory.active, open_questions: [...memory.active.open_questions, question] } }
}

export function resolveOpenQuestion(memory: ProjectMemory, question: string): ProjectMemory {
  return {
    ...memory,
    active: {
      ...memory.active,
      open_questions: memory.active.open_questions.filter(q => q !== question),
    },
  }
}

export function addConflict(memory: ProjectMemory, primaryPosition: string, reviewerPosition: string): ProjectMemory {
  const conflict: Conflict = {
    id: generateId(),
    primaryPosition,
    reviewerPosition,
  }
  return { ...memory, active: { ...memory.active, unresolved_conflicts: [...memory.active.unresolved_conflicts, conflict] } }
}

export function resolveConflict(memory: ProjectMemory, conflictId: string, resolution: string): ProjectMemory {
  const conflict = memory.active.unresolved_conflicts.find(c => c.id === conflictId)
  if (!conflict) return memory

  const resolved = { ...conflict, resolvedAt: Date.now(), resolution }
  return {
    active: {
      ...memory.active,
      unresolved_conflicts: memory.active.unresolved_conflicts.filter(c => c.id !== conflictId),
    },
    archive: {
      ...memory.archive,
      resolved_decisions: [
        ...memory.archive.resolved_decisions,
        {
          id:          generateId(),
          description: `Conflict resolved: Primary said "${conflict.primaryPosition.slice(0, 80)}"`,
          reason:      resolution,
          timestamp:   Date.now(),
        },
      ],
    },
  }
}

// ─── Compression (trim active memory when over 8k tokens) ────────────────────

export function compressActiveMemory(memory: ProjectMemory): ProjectMemory {
  if (!needsCompression(memory)) return memory

  const { active, archive } = memory

  // Move all but last 5 recent_decisions to archive
  const toArchive = active.recent_decisions.slice(0, -5)
  const kept      = active.recent_decisions.slice(-5)

  return {
    active: { ...active, recent_decisions: kept },
    archive: {
      ...archive,
      resolved_decisions: [...archive.resolved_decisions, ...toArchive],
    },
  }
}
