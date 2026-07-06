import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// ─── Projects ─────────────────────────────────────────────────────────────────
// Moved from Redis — was project:{userId}:{id} + projects:{userId} set

export const projects = sqliteTable('projects', {
  id:           text('id').primaryKey(),
  name:         text('name').notNull(),
  description:  text('description').notNull().default(''),
  // Coder is always DeepSeek — not stored per-project, only R1/R2 vary.
  r1Provider:   text('r1_provider').notNull(),
  r1ModelId:    text('r1_model_id').notNull(),
  r2Provider:   text('r2_provider').notNull(),
  r2ModelId:    text('r2_model_id').notNull(),
  createdAt:    integer('created_at').notNull(),  // unix ms
  // Workspace: absolute host path to a local folder. Null = JSON-only mode.
  workspaceDir: text('workspace_dir'),
})

// ─── API Credentials ──────────────────────────────────────────────────────────
// Was in Neon with foreign key to users. Now single-user, no FK needed.

export const apiCredentials = sqliteTable('api_credentials', {
  id:           text('id').primaryKey(),
  provider:     text('provider').notNull().unique(),
  encryptedKey: text('encrypted_key').notNull(),
  isValid:      integer('is_valid', { mode: 'boolean' }).notNull().default(false),
  createdAt:    integer('created_at').notNull(),
})

// ─── Budget — per-provider monthly spend ──────────────────────────────────────
// Moved from Redis incrbyfloat keys

export const budgetSpend = sqliteTable(
  'budget_spend',
  {
    provider:  text('provider').notNull(),
    yearMonth: text('year_month').notNull(),
    spendUsd:  real('spend_usd').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.yearMonth] }),
  }),
)

// ─── Budget — per-provider caps ───────────────────────────────────────────────

export const providerCaps = sqliteTable('provider_caps', {
  provider: text('provider').primaryKey(),
  capUsd:   real('cap_usd').notNull(),
})

// ─── Budget — per-session cost tracking ───────────────────────────────────────

export const sessionCosts = sqliteTable('session_costs', {
  sessionId: text('session_id').primaryKey(),
  costUsd:   real('cost_usd').notNull().default(0),
  tokens:    integer('tokens').notNull().default(0),
})

// ─── Pipeline Sessions — crash-recovery checkpoints ──────────────────────────
// API keys are NEVER stored here — stripped before JSON.stringify, re-hydrated
// from api_credentials on load.

export const pipelineSessions = sqliteTable('pipeline_sessions', {
  sessionId: text('session_id').primaryKey(),
  projectId: text('project_id').notNull(),
  phase:     text('phase').notNull(),
  stateJson: text('state_json').notNull(),
  updatedAt: integer('updated_at').notNull(),   // unix ms
})

// ─── Types ────────────────────────────────────────────────────────────────────

export type Project        = typeof projects.$inferSelect
export type NewProject     = typeof projects.$inferInsert
export type ApiCredential  = typeof apiCredentials.$inferSelect
export type NewApiCredential = typeof apiCredentials.$inferInsert
