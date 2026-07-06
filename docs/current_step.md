# Current Build Step
Step: PROMPT 6 — Native npm distribution
Status: COMPLETE
Started: 2026-07-06
Last Updated: 2026-07-06

## What Is Done In This Step

- `bin/crucible.mjs` — launcher CLI with `start`, `doctor`, `reset --confirm` commands
- First-run setup: creates `~/.crucible/data/` + `~/.crucible/logs/`, generates `secret.key` (0600)
- `CRUCIBLE_HOME` override respected throughout (env → default ~/.crucible)
- Server bound to 127.0.0.1 by default; `--host 0.0.0.0` as explicit opt-in with warning
- Port auto-fallback via `net.createServer` probe when requested port is busy
- Browser auto-opens after 1.5s delay (xdg-open / open / start per platform)
- `crucible doctor`: Node version, CRUCIBLE_HOME writable, key validity, data dir, DB schema, build present, git, claude CLI, codex CLI — exits non-zero on critical failures
- `crucible reset --confirm`: wipes `pipeline_sessions` + `session_costs` via inline CJS script against standalone/node_modules/better-sqlite3
- `scripts/postbuild.mjs`: copies .next/static, public/, drizzle/, better-sqlite3 into standalone
- `src/lib/crypto/index.ts`: getKey() reads ENCRYPTION_KEY env first, then key file (native fallback)
- `package.json`: bin, files, engines, description, postbuild script; "private" removed
- `sentry.server.config.ts`: distribution tag (native | docker) on all events
- README.md: native install as primary Quick Start, Docker as alternative section
- tsc clean, 58/58 tests passing

## What Remains In This Step

- Full smoke test: `npm run build && npm pack && npm install -g crucible-*.tgz && crucible doctor`
  (requires a complete build environment — deferred to CI / release workflow)

## Blockers

- None

## Next

- PROMPT 7 (TBD)
- Workspace linking (P7): link project output to a local folder using the native data dir
- CLI reviewer backends (P11): crucible now installs cleanly so CLI tool integration is simpler
