import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import path from 'path'
import fs from 'fs'
import * as schema from './schema'

const dataDir = process.env.DATA_DIR ?? './data'
const dbPath  = path.join(dataDir, 'crucible.db')

// Ensure data directory exists before opening DB
fs.mkdirSync(dataDir, { recursive: true })

const sqlite = new Database(dbPath)

// WAL mode: better read/write concurrency, faster writes
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })

// ─── Auto-migrate on startup ──────────────────────────────────────────────────
// Creates tables if they don't exist. Safe to run on every startup.
// Drizzle generates migration files from the schema — run `drizzle-kit generate`
// once to create them, then this runs them automatically on app start.
//
// For a fresh install with no migration files, use `drizzle-kit push` once manually:
//   DATA_DIR=./data npx drizzle-kit push
//
// After that, this auto-migrate handles subsequent schema changes.

const migrationsFolder = path.join(process.cwd(), 'drizzle')
if (fs.existsSync(migrationsFolder)) {
  try {
    migrate(db, { migrationsFolder })
  } catch (err) {
    // Migrations may fail if tables already exist from a drizzle-kit push.
    // Log but don't crash — the schema is already in place.
    console.warn('[db] migrate() warning:', err instanceof Error ? err.message : err)
  }
}

// Purge stale pipeline sessions (>7 days) on startup — safety net for orphaned rows
try {
  sqlite.prepare('DELETE FROM pipeline_sessions WHERE updated_at < ?')
    .run(Date.now() - 7 * 24 * 60 * 60 * 1000)
} catch { /* table may not exist on very first run before migrations */ }

export { schema }
