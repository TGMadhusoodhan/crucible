#!/usr/bin/env node
/**
 * Post-build: copies assets into .next/standalone/ so it is self-contained
 * for both npm publish and Docker deployment.
 *
 * Copies:
 *   .next/static  → .next/standalone/.next/static   (client bundles, fonts, images)
 *   public/       → .next/standalone/public/         (favicon, robots.txt, etc.)
 *   drizzle/      → .next/standalone/drizzle/        (SQL migration files)
 *   node_modules/better-sqlite3 → .next/standalone/node_modules/better-sqlite3
 *     (native module; Next.js file tracing may miss it due to serverExternalPackages)
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT       = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STANDALONE = path.join(ROOT, '.next', 'standalone')

if (!fs.existsSync(STANDALONE)) {
  console.error('No .next/standalone found — run `npm run build` first')
  process.exit(1)
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

const steps = [
  ['.next/static',              '.next/standalone/.next/static'],
  ['public',                    '.next/standalone/public'],
  ['drizzle',                   '.next/standalone/drizzle'],
]

for (const [rel, destRel] of steps) {
  const src  = path.join(ROOT, rel)
  const dest = path.join(ROOT, destRel)
  if (fs.existsSync(src)) {
    process.stdout.write(`  → ${rel} → ${destRel}\n`)
    copyDir(src, dest)
  }
}

// better-sqlite3: always ensure it's present in standalone/node_modules
const bsSrc  = path.join(ROOT, 'node_modules', 'better-sqlite3')
const bsDest = path.join(STANDALONE, 'node_modules', 'better-sqlite3')
if (fs.existsSync(bsSrc)) {
  process.stdout.write(`  → node_modules/better-sqlite3 → standalone/node_modules/better-sqlite3\n`)
  copyDir(bsSrc, bsDest)
}

console.log('✓ Standalone ready for distribution')
