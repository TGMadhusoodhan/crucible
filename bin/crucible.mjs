#!/usr/bin/env node
/**
 * Crucible launcher — plain Node ESM, no deps beyond Node built-ins.
 *
 * Usage:
 *   crucible [start] [--port <n>] [--host <addr>]
 *   crucible doctor
 *   crucible reset --confirm
 */
import { createServer } from 'net'
import { spawn, spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename  = fileURLToPath(import.meta.url)
const PKG_ROOT    = path.resolve(path.dirname(__filename), '..')
const STANDALONE  = path.join(PKG_ROOT, '.next', 'standalone')
const SERVER_JS   = path.join(STANDALONE, 'server.js')

// ─── Path helpers ─────────────────────────────────────────────────────────────

function crucibleHome() {
  return process.env.CRUCIBLE_HOME ?? path.join(os.homedir(), '.crucible')
}

function dataDir(home) {
  return path.join(home, 'data')
}

function keyFilePath(home) {
  return path.join(home, 'secret.key')
}

// ─── First-run setup ──────────────────────────────────────────────────────────

function ensureFirstRun(home) {
  fs.mkdirSync(path.join(home, 'data'), { recursive: true })
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true })

  const kf = keyFilePath(home)
  if (!fs.existsSync(kf)) {
    const key = randomBytes(32).toString('hex')
    fs.writeFileSync(kf, key + '\n', { mode: 0o600 })
    console.log(`  Generated encryption key → ${kf}`)
    console.log('  Keep this file safe. Losing or changing it makes stored API keys unreadable.\n')
    return key
  }
  return fs.readFileSync(kf, 'utf8').trim()
}

// ─── Port probe ───────────────────────────────────────────────────────────────

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        srv.close(() => resolve(findFreePort(start + 1)))
      } else {
        reject(err)
      }
    })
    srv.listen(start, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// ─── Browser open ─────────────────────────────────────────────────────────────

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'start'
    : process.platform === 'darwin'        ? 'open'
    : 'xdg-open'
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref()
  } catch { /* best-effort */ }
}

// ─── start command ────────────────────────────────────────────────────────────

async function cmdStart(args) {
  let requestedPort = 3000
  let host = '127.0.0.1'

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      const n = parseInt(args[++i], 10)
      if (!Number.isFinite(n) || n < 1 || n > 65535) die('Invalid port number')
      requestedPort = n
    } else if (args[i] === '--host' && args[i + 1]) {
      host = args[++i]
    }
  }

  if (host !== '127.0.0.1') {
    console.warn('WARNING: Listening on all interfaces. This app holds encrypted API keys.')
    console.warn('         Only use --host 0.0.0.0 on a private trusted network.\n')
  }

  if (!fs.existsSync(SERVER_JS)) {
    die(`Server not found at: ${SERVER_JS}\nBuild first: npm run build`)
  }

  const home = crucibleHome()
  console.log(`Crucible home: ${home}`)
  const encKey = ensureFirstRun(home)

  const port = await findFreePort(requestedPort)
  if (port !== requestedPort) {
    console.log(`  Port ${requestedPort} in use — using ${port}\n`)
  }

  const env = {
    ...process.env,
    NODE_ENV:                'production',
    NEXT_TELEMETRY_DISABLED: '1',
    PORT:                    String(port),
    HOSTNAME:                host,
    DATA_DIR:                dataDir(home),
    ENCRYPTION_KEY:          encKey,
    CRUCIBLE_HOME:           home,
    CRUCIBLE_DISTRIBUTION:   'native',
  }

  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host
  const url = `http://${displayHost}:${port}`
  console.log(`Crucible → ${url}\n`)

  const child = spawn('node', [SERVER_JS], { cwd: STANDALONE, env, stdio: 'inherit' })

  setTimeout(() => openBrowser(url), 1500)

  const shutdown = (sig) => { child.kill(sig); process.exit(0) }
  process.on('SIGINT',  () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  child.on('exit', (code) => process.exit(code ?? 0))
}

// ─── doctor command ───────────────────────────────────────────────────────────

async function cmdDoctor() {
  const lines = []
  let exitCode = 0

  function check(label, ok, note, critical = false) {
    const icon = ok ? '✓' : critical ? '✗' : '!'
    lines.push(`  ${icon}  ${label}${note ? ': ' + note : ''}`)
    if (!ok && critical) exitCode = 1
  }

  // Node.js version
  const major = Number(process.versions.node.split('.')[0])
  check('Node.js', major >= 20, `v${process.versions.node}${major < 20 ? ' (requires ≥ 20)' : ''}`, true)

  // CRUCIBLE_HOME writable
  const home = crucibleHome()
  let homeWritable = false
  try {
    fs.mkdirSync(home, { recursive: true })
    const probe = path.join(home, '.write-probe')
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
    homeWritable = true
  } catch (e) {
    check('CRUCIBLE_HOME writable', false, `${home} — ${e.message}`, true)
  }
  if (homeWritable) check('CRUCIBLE_HOME writable', true, home)

  // Encryption key
  const kf = keyFilePath(home)
  const envKey = process.env.ENCRYPTION_KEY
  if (envKey) {
    const valid = /^[0-9a-fA-F]{64}$/.test(envKey.trim())
    check('Encryption key (ENCRYPTION_KEY env)', valid,
      valid ? 'present, valid' : 'invalid — must be 64 hex chars', true)
  } else if (fs.existsSync(kf)) {
    const raw  = fs.readFileSync(kf, 'utf8').trim()
    const valid = /^[0-9a-fA-F]{64}$/.test(raw)
    check('Encryption key (secret.key)', valid,
      valid ? kf : `invalid hex at ${kf}`, true)
  } else {
    check('Encryption key', false, 'not found — run "crucible" to auto-generate', true)
  }

  // Data directory
  const dd = dataDir(home)
  check('Data directory', fs.existsSync(dd), dd + (fs.existsSync(dd) ? '' : ' (will be created on first start)'))

  // DB schema
  const dbPath = path.join(dd, 'crucible.db')
  const bsPath = path.join(STANDALONE, 'node_modules', 'better-sqlite3')
  if (fs.existsSync(dbPath) && fs.existsSync(bsPath)) {
    const dbScript = `
      try {
        const DB = require(${JSON.stringify(bsPath)})
        const db = new DB(${JSON.stringify(dbPath)}, { readonly: true })
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
        const required = ['projects','api_credentials','pipeline_sessions']
        const missing = required.filter(t => !tables.includes(t))
        process.stdout.write(JSON.stringify({ ok: missing.length === 0, tables, missing }))
        db.close()
      } catch(e) { process.stdout.write(JSON.stringify({ ok: false, error: e.message })) }
    `
    const res = spawnSync('node', ['-e', dbScript], { encoding: 'utf8' })
    try {
      const parsed = JSON.parse(res.stdout ?? '{}')
      check('DB schema', parsed.ok,
        parsed.ok
          ? `${parsed.tables?.length ?? 0} tables`
          : (parsed.error ?? `missing: ${(parsed.missing ?? []).join(', ')}`))
    } catch {
      check('DB schema', false, 'could not read database')
    }
  } else if (fs.existsSync(dbPath)) {
    check('DB schema', true, `${dbPath} exists`)
  } else {
    check('DB schema', true, 'not yet created (will auto-migrate on first start)')
  }

  // Next.js build
  const built = fs.existsSync(SERVER_JS)
  check('Next.js standalone build', built, built ? STANDALONE : 'run: npm run build', !built)

  // git
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' })
  check('git', git.status === 0, git.status === 0 ? '' : 'not found (optional)')

  // claude CLI
  const claudeCli = spawnSync('claude', ['--version'], { encoding: 'utf8' })
  check('claude CLI', claudeCli.status === 0, claudeCli.status === 0 ? '' : 'not installed (optional)')

  // codex CLI
  const codexCli = spawnSync('codex', ['--version'], { encoding: 'utf8' })
  check('codex CLI', codexCli.status === 0, codexCli.status === 0 ? '' : 'not installed (optional)')

  console.log('\nCrucible Doctor\n')
  for (const line of lines) console.log(line)
  console.log()
  if (exitCode !== 0) {
    console.log('✗ One or more critical checks failed.\n')
  } else {
    console.log('✓ All critical checks passed.\n')
  }
  process.exit(exitCode)
}

// ─── reset command ────────────────────────────────────────────────────────────

function cmdReset(args) {
  if (!args.includes('--confirm')) {
    console.error('Add --confirm to proceed: crucible reset --confirm')
    console.error('Wipes in-progress pipeline sessions. Projects and API keys are untouched.')
    process.exit(1)
  }

  const home   = crucibleHome()
  const dbPath = path.join(dataDir(home), 'crucible.db')

  if (!fs.existsSync(dbPath)) {
    console.log('No database found. Nothing to reset.')
    return
  }

  const bsPath = path.join(STANDALONE, 'node_modules', 'better-sqlite3')
  const script = `
    const DB = require(${JSON.stringify(bsPath)})
    const db = new DB(${JSON.stringify(dbPath)})
    db.prepare('DELETE FROM pipeline_sessions').run()
    db.prepare('DELETE FROM session_costs').run()
    db.close()
    console.log('Sessions cleared.')
  `
  const res = spawnSync('node', ['-e', script], { stdio: 'inherit' })
  process.exit(res.status ?? 0)
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(`Error: ${msg}`)
  process.exit(1)
}

function usage() {
  console.log('Usage:')
  console.log('  crucible [start] [--port <n>] [--host <addr>]')
  console.log('  crucible doctor')
  console.log('  crucible reset --confirm')
}

// ─── main ─────────────────────────────────────────────────────────────────────

const [,, rawCmd, ...rest] = process.argv

if (!rawCmd || rawCmd === 'start' || rawCmd.startsWith('-')) {
  const startArgs = rawCmd && rawCmd !== 'start' ? [rawCmd, ...rest] : rest
  await cmdStart(startArgs)
} else {
  switch (rawCmd) {
    case 'doctor': await cmdDoctor(); break
    case 'reset':  cmdReset(rest); break
    case '--help': case '-h': usage(); break
    default:
      console.error(`Unknown command: ${rawCmd}`)
      usage()
      process.exit(1)
  }
}
