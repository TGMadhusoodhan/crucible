import { z } from 'zod'

// Re-export all existing model-output schemas from a single import point.
export {
  thinkingOutputSchema,
  fileManifestSchema,
  reviewHunkSchema,
  reviewHunksSchema,
  crossReviewResponseSchema,
} from '@/types'

// ─── Phase 1.5 — Alignment output ────────────────────────────────────────────
// The shape the model returns in response to ALIGNMENT_SYSTEM_PROMPT.

export const alignmentOutputSchema = z.object({
  understood_as:     z.string().catch(''),
  questions_summary: z.array(z.string()).catch([]),
  position:          z.string().catch(''),
})

// ─── Phase 2 — Flat spec model output ────────────────────────────────────────
// The model returns this flat shape. buildSpecDocument maps it to SpecDocument.
// .passthrough() keeps any extra fields models may add.

export const specModelOutputSchema = z.object({
  task_description:    z.string().catch(''),
  tech_stack:          z.array(z.string()).catch([]),
  requirements:        z.array(z.string()).catch([]),
  constraints:         z.array(z.string()).catch([]),
  edge_cases:          z.array(z.string()).catch([]),
  out_of_scope:        z.array(z.string()).catch([]),
  acceptance_criteria: z.array(z.string()).catch([]),
}).passthrough()

// ─── Phase 2 — Combined spec + manifest response ──────────────────────────────
// STRICT on structural fields (filename, exports, generation_order) —
// structural failures trigger parseWithRepair rather than silently coercing.

export const specAndManifestOutputSchema = z.object({
  spec:     specModelOutputSchema,
  manifest: z.object({
    mode:             z.enum(['single', 'multi']).catch('single'),
    // No .catch([]) — a structurally invalid file (empty filename, non-array exports)
    // fails the whole manifest and triggers parseWithRepair.
    files:            z.array(z.object({
      filename: z.string().min(1),              // STRICT
      purpose:  z.string().catch(''),
      exports:  z.array(z.string()),            // STRICT
      imports:  z.record(z.string(), z.array(z.string())).catch({}),
    })),
    generation_order: z.array(z.string()),      // STRICT
    reasoning:        z.string().catch(''),
  }),
}).passthrough()

// ─── Phase 3 — Strict review hunk schema ─────────────────────────────────────
// Structural fields are STRICT (no .catch()): filename, severity enum,
// fixed_code. If any hunk violates these, the parse fails and parseWithRepair
// retries. Cosmetic/display fields (.catch()) tolerate minor model variation.

export const reviewHunkStrictSchema = z.object({
  id:            z.string().catch(() => `h_${Math.random().toString(36).slice(2, 8)}`),
  filename:      z.string().min(1),                // STRICT
  line_start:    z.number().int().min(1).catch(1),
  line_end:      z.number().int().min(1).catch(1),
  severity:      z.enum(['HIGH', 'MEDIUM', 'LOW']), // STRICT
  issue:         z.string().catch(''),
  original_code: z.string().optional(),            // STRICT shape, field itself optional
  fixed_code:    z.string(),                       // STRICT
  category:      z.enum([
    'logic', 'security', 'performance', 'correctness',
    'missing_implementation', 'edge_case', 'contract_violation',
  ]).catch('logic'),
})

// No outer .catch([]) — a non-array response triggers parseWithRepair.
export const reviewHunksStrictSchema = z.array(reviewHunkStrictSchema)
