# Crucible

> Bring any AI. Build better code.

Crucible routes every coding task through three AI models: a **primary coder** (DeepSeek) generates the code, and **two independent reviewers** from different training families cross-validate it. Conflicts between reviewers are resolved before code reaches you.

You bring your own API keys. Crucible is the pipeline.

---

## Quick start

```bash
npm install -g crucible
crucible
```

That's it. On first run, Crucible auto-generates an encryption key, creates `~/.crucible/`, starts the server on `http://localhost:3000`, and opens your browser. No manual setup.

After the browser opens:
1. Go to **Settings → API Keys** and add keys for at least two reviewer providers
2. Click **New project** and choose your R1 and R2 reviewer models
3. Describe your task and click **Start pipeline**

**Recommended first pairing:** Claude Sonnet 4.6 (R1) + GPT-4o (R2). Different training families, genuine blind spot coverage. DeepSeek V4 Pro is locked in as the primary coder at ~$0.65/M blended.

### CLI reference

```bash
crucible                        # start server (default port 3000)
crucible start --port 8080      # explicit port (auto-falls back if busy)
crucible start --host 0.0.0.0   # listen on all interfaces (see warning below)
crucible doctor                 # environment health check
crucible reset --confirm        # wipe in-progress sessions for recovery
```

> **Security note:** Crucible binds to `127.0.0.1` by default. It holds encrypted API keys and writes to the local filesystem. Only use `--host 0.0.0.0` on a private, trusted network.

### Data directory

All data lives in `~/.crucible/` by default. Override with `CRUCIBLE_HOME=/path/to/dir crucible`.

```
~/.crucible/
├── secret.key    # AES-256 encryption key — auto-generated, never change
├── data/
│   ├── crucible.db              # SQLite — projects, encrypted API keys, budget
│   └── projects/{id}/
│       ├── output.json          # Restored automatically when you reopen a project
│       ├── output/              # Individual accepted files
│       ├── spec.json            # Locked after Phase 2
│       ├── session.jsonl        # Append-only event log
│       └── checkpoints/         # Snapshots at key milestones
└── logs/
```

---

## Why three models?

Every model has blind spots baked in by its training data. The same model that wrote the bug is the one you're asking to find it. Crucible breaks that loop:

- DeepSeek generates the code. R1 and R2 review it independently. Different companies, different training — genuine cross-validation.
- Each reviewer produces structured edit hunks. They never rewrite the whole file.
- R1 and R2 then evaluate each other's proposed hunks. Agreements are applied automatically; genuine conflicts surface to you.
- When rounds are exhausted, you decide: regenerate with guidance, accept as-is, or choose a side.

The result: code that has been written, independently reviewed by two models, cross-validated, and disputed before it reaches you.

---

## Features

- **Three-model pipeline** — DeepSeek generates; two reviewers from different training families cross-validate, each independently, before comparing notes
- **Dual independent review** — R1 and R2 each produce structured edit hunks in parallel; their hunks are cross-validated before any change is applied
- **Cross-review conflict resolution** — R1 evaluates R2's hunks and vice versa; agreements auto-apply; genuine conflicts go to a human micro-gate
- **Human micro-gate** — when R1 and R2 disagree, you see both positions and pick one before patching continues
- **Per-file output gate** — each generated file is presented one at a time; send targeted feedback or accept; all files accepted → pipeline complete
- **Human arbitration** — when rounds are exhausted, your decision is final and injected directly into the pipeline
- **Workspace memory** — link a project to a local folder; Crucible maintains a `.crucible/` directory with a running interface index, decision log, and CRUCIBLE.md context file injected into every session
- **GitHub integration** — connect a GitHub repo to a project; accepted files push automatically (per-file or per-session) via your Personal Access Token
- **CLI subscription backends** — use Claude Code or Codex as R1/R2 reviewers with your existing subscription — no API key required for those slots
- **Budget governor** — per-provider spend caps with automatic mode switching so one heavy session can't exhaust your budget
- **ZIP download** — download all accepted files as a ZIP with one click from the Files section
- **Any reviewer providers** — Claude, GPT, Gemini, Mistral, OpenRouter, Groq, Together AI, Z.ai — mix and match freely

---

## Alternative: Docker

Docker is the recommended option for self-hosting on a server where you want data persistence across reboots.

### 1. Set your encryption key

```bash
cp .env.example .env
# Add to .env:
ENCRYPTION_KEY=$(openssl rand -hex 32)
```

> **Important:** Never change `ENCRYPTION_KEY` after the first run. All API keys you store are encrypted with it.

### 2. Start

```bash
docker compose up -d
```

View logs:

```bash
docker compose logs -f
```

All project data is written to `/data` inside the container, mounted as the `crucible_data` volume.

> **Note:** CLI subscription backends (claude-code, codex) are unavailable in Docker — they require a locally installed CLI on the host.

---

## How the pipeline works

Crucible runs through four phases. You only provide input at the marked gates — everything else runs automatically.

```
Phase 1 — Think
  Both reviewers analyze your task independently in parallel.
  Each produces assumptions, questions, and a recommended approach.

Phase 1.5 — Align
  Reviewers compare interpretations and flag architectural disagreements.
  Mismatches surface here, before a single line of code is written.

Phase 2 — Q&A + Spec                           ← Gate 1: you answer questions
  Required questions are presented once.
  You answer them; non-required questions are auto-answered.
  R1 and R2 jointly propose a spec and file manifest.
                                                ← Gate 2: you confirm the spec

Phase 3 — Generate + Review loop (per file, rounds 1–3)
  DeepSeek generates the current file (streaming).
  R1 and R2 each independently review + produce surgical edit hunks (parallel).
  R1 evaluates R2's hunks; R2 evaluates R1's hunks (cross-review).
  Agreed hunks are applied. Conflicting hunks go to:
                                                ← Gate 3: micro-gate (R1 vs R2 conflict)
  DeepSeek applies resolved patches.
  R1+R2 verify the patched file. Next round if issues remain.
  After round 3, if still unresolved:
                                                ← Gate 4: arbitration (regenerate / pick side / accept)

Output gate                                     ← Gate 5: per-file approval
  Each completed file is presented one at a time.
  Send targeted feedback for changes, or accept.
  All files accepted → pipeline complete.
```

### Phase reference

| Phase | What happens | Your input? |
|---|---|---|
| `phase1_thinking` | R1 and R2 analyze the task in parallel | — |
| `phase1_5_alignment` | Reviewers reconcile interpretations (max 2 rounds) | — |
| `phase2_questions` | Questions compiled; non-required ones auto-answered | — |
| `phase2_answering` | You answer required questions | **Gate 1** |
| `phase2_contradiction_check` | Contradiction check on your answers | — |
| `phase2_spec_and_manifest` | R1+R2 jointly propose spec + file manifest | — |
| `phase2_confirm` | You confirm the spec before generation starts | **Gate 2** |
| `phase3_generating` | DeepSeek streams the current file | — |
| `phase3_reviewing` | R1+R2 independently review+patch in parallel | — |
| `phase3_cross_review` | R1+R2 evaluate each other's conflicting hunks | — |
| `phase3_micro_gate` | R1 and R2 disagree; you choose | **Gate 3** |
| `phase3_patching` | DeepSeek applies resolved patches | — |
| `phase3_re_review` | R1+R2 verify patched file | — |
| `phase3_arbitration` | Round 3 exhausted; regenerate / pick side / accept as-is | **Gate 4** |
| `phase3_budget_gate` | Authorize spend before each file (CRITICAL mode) | **Gate (budget)** |
| `output_gate` | You review each completed file; request changes or accept | **Gate 5** |
| `complete` | All files accepted | — |

---

## Configuration

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `CRUCIBLE_HOME` | No | Home directory for Crucible data (default: `~/.crucible`) |
| `ENCRYPTION_KEY` | No* | AES-256-GCM key for stored API keys. Auto-generated on first run if absent. Docker users must set this manually. |
| `DATA_DIR` | No | Override for data subdirectory (default: `$CRUCIBLE_HOME/data`) |
| `NEXT_PUBLIC_APP_URL` | No | App URL — used by OpenRouter for HTTP-Referer (default: `http://localhost:3000`) |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Sentry error tracking DSN |
| `SENTRY_AUTH_TOKEN` | No | Sentry source map upload token |

*Required when running via Docker. Auto-generated at `~/.crucible/secret.key` for native installs.

### Supported providers

Add API keys under **Settings → API Keys**. R1 and R2 can use any combination of these providers.

| Provider | Models / Notes |
|---|---|
| DeepSeek | `deepseek-v4-pro`, `deepseek-v4-flash` — primary coder (fixed) |
| Anthropic | `claude-sonnet-4-6`, `claude-opus-4-7` |
| OpenAI | `gpt-4o`, `gpt-5-4`, `gpt-5-5` |
| Google | `gemini-pro`, `gemini-flash` |
| Mistral | `mistral-large`, `codestral` |
| Z.ai | `zai` models via z.ai |
| OpenRouter | any model via openrouter.ai |
| Groq | fast inference models |
| Together AI | together.ai models |
| **Claude Code** | uses your local `claude` CLI — no API key needed |
| **Codex** | uses your local `codex` CLI — no API key needed |

> R1 and R2 must use different providers to ensure genuine cross-validation.

### CLI subscription backends

If you have an active Claude Pro or Codex subscription, you can use those as R1 or R2 without any API key:

1. Install the CLI: `npm install -g @anthropic-ai/claude-code` or `npm install -g @openai/codex`
2. Log in once via the CLI
3. In Crucible's Settings → CLI Subscriptions, verify detection shows the correct version and login state
4. When creating a project, select **Claude Code** or **Codex** as R1 or R2

Latency is higher than API calls (cold start per request). Not available in Docker.

### Budget governor

Crucible tracks spend per provider and switches modes automatically.

| Mode | Remaining budget | Effect |
|---|---|---|
| `FULL` | > 75% | Normal operation |
| `EFFICIENT` | 50–75% | HIGH-severity issues only; review rounds capped at 2 |
| `CONSERVATION` | 25–50% | Single-reviewer mode; R2 idle; `budget_degradation` event emitted |
| `CRITICAL` | < 25% | Budget gate before each file; spend + estimated cost shown |

Set per-provider monthly caps under **Settings → Budget**.

### Workspace memory

When you link a project to a local folder, Crucible maintains a `.crucible/` directory inside it:

```
your-project/
└── .crucible/
    ├── CRUCIBLE.md        # auto-updated context injected into every session
    ├── registry.json      # interface index: exported symbols + signatures per file
    ├── history.jsonl      # append-only session event log
    └── spec.json          # locked spec from Phase 2
```

On each session resume, the interface index provides R1, R2, and DeepSeek with the signatures of already-accepted files — enabling cross-file type checking and preventing duplicate symbol definitions without reading entire files.

### GitHub integration

Connect a GitHub repo to a project under the **GitHub** tab in project settings:

1. Add a GitHub Personal Access Token under **Settings → API Keys**
2. Open a project → **GitHub** tab → link an existing repo or create a new one
3. Choose push mode: **per file** (push each accepted file immediately) or **per session** (push all at pipeline complete)

Accepted files are committed and pushed to the configured branch automatically.

---

## API key security

API keys stored in the database are encrypted with AES-256-GCM using the encryption key. They are:

- Never logged on the server or sent to the browser
- Decrypted only at the moment of an API call, in server memory only
- Validated with a live API call before being marked valid and stored

The encryption key itself is stored at `~/.crucible/secret.key` (mode 0600) for native installs, or as `ENCRYPTION_KEY` env var for Docker. Never share, move, or change it — all stored API keys depend on it.

---

## Token pricing reference

*June 2026, per million tokens*

| Model | Input | Output |
|---|---|---|
| DeepSeek V4 Pro | $0.435 | $0.870 |
| DeepSeek V4 Flash | $0.140 | $0.280 |
| Claude Sonnet 4.6 | $3.00 | $15.00 |
| Claude Opus 4.7 | $5.00 | $25.00 |
| GPT-4o | $2.50 | $10.00 |
| Gemini Pro | $1.25 | $5.00 |
| Mistral Large | $2.00 | $6.00 |
| Qwen3 Coder Next | $0.11 | $0.80 |

---

## Troubleshooting

### "Session not found" after a page refresh

**Cause:** Pipeline session state lives in a server-side in-process Map. It survives hot reloads but not a full server restart.

**Fix:** Start a new pipeline session. Previously accepted output restores automatically from `output.json` when you reopen the project.

---

### Pipeline stalls and keeps showing "auto-reconnecting…"

**Cause:** The model API returned an empty response. The client reconnects automatically at pipeline boundaries, but repeated reconnects without reaching a human gate indicate a provider problem.

**Fix:** Check that:
- Your API key is valid (**Settings → API Keys**)
- The model ID exists on that provider
- You haven't hit the provider's rate limit (wait a moment and retry)

---

### Code panel is blank during Phase 3

**Cause:** Reasoning models (DeepSeek V4 Pro, Claude Opus) can think silently for several minutes before streaming their first token.

**Fix:** Wait up to 5 minutes. If nothing appears, stop the session and retry with a faster model such as DeepSeek V4 Flash or GPT-4o.

---

### "Encryption key mismatch" when loading API keys

**Cause:** The encryption key was changed after API keys were stored.

**Fix:** Delete the affected credentials in **Settings → API Keys** and re-enter them. Encrypted values cannot be recovered after a key change.

For native installs: `~/.crucible/secret.key` must never be deleted or overwritten. Crucible never regenerates it if the file exists.

---

### Files section is empty after the pipeline completes

**Cause:** Individual files are only written when you accept each file at the output gate.

**Fix:** Refresh the Files page. If still empty, open the Conversation tab and confirm consensus was reached for each file.

---

### Task description too long

**Fix:** Move large code pastes to the **Context** field. Descriptions cap at 50,000 characters; context at 40,000.

---

### OpenAI models error with "max_tokens too large"

**Fix:** Update `max_tokens` in `src/lib/adapters/openai-compatible.ts` to match the model's actual limit.

---

### Docker container exits immediately

**Fix:**
```bash
docker compose config   # confirm ENCRYPTION_KEY is present in the resolved env
docker compose logs     # read the startup error
```

---

## Adding a provider

Adding a new model provider touches one file and requires no pipeline changes.

1. Create `src/lib/adapters/your-provider.ts`
2. Extend `OpenAICompatibleAdapter` if the provider uses the OpenAI API shape (Groq, Together, DeepSeek, Mistral, and Z.ai all do). Otherwise extend `BaseAdapter` directly.
3. Implement `getProvider()` and any methods that need provider-specific behaviour. Everything else inherits.
4. Add your provider to the `switch` in `src/lib/adapters/index.ts`

---

## Contributing

```bash
git checkout -b feature/my-change
npm test                       # unit tests, no API keys needed
npx tsc --noEmit               # must be zero errors before opening a PR
```

- **New provider:** See [Adding a provider](#adding-a-provider) above — four steps, one file.
- **Bugs and features:** Open a GitHub issue.
- **Architecture questions:** Read `docs/decisions.md` for the reasoning behind every major design choice before proposing pipeline changes.

---

## License

MIT
