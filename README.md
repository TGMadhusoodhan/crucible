# Crucible

> Bring any AI. Build better code.

Crucible routes every coding task through two AI models from different companies. A **primary coder** generates the code. A **reviewer** from a different training family cross-validates it. Code only reaches you when both models agree.

You bring your own API keys. Crucible is the pipeline.

---

## Quick start

```bash
npm install -g crucible
crucible
```

That's it. On first run, Crucible auto-generates an encryption key, creates `~/.crucible/`, starts the server on `http://localhost:3000`, and opens your browser. No manual setup.

After the browser opens:
1. Go to **Settings → API Keys** and add keys for at least two providers
2. Click **New project** and choose your primary coder and reviewer models
3. Describe your task and click **Start pipeline**

**Recommended first pairing:** DeepSeek V4 Pro (primary) + Claude Sonnet 4.6 (reviewer). Different training families, genuine blind spot coverage, and ~36M tokens for $25/month vs Claude Pro's 1–2M.

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

## Why two models?

Every model has blind spots baked in by its training data. The same model that wrote the bug is the one you're asking to find it. Crucible breaks that loop:

- DeepSeek writes the code. Claude reviews it. Different companies, different training — genuine cross-validation.
- The reviewer never rewrites. It flags issues and produces surgical edits; the coder evaluates each one.
- When they disagree, they negotiate. When they can't resolve it, you decide.

The result: code that has been written, self-checked, independently reviewed, and disputed before it reaches you.

---

## Features

- **Two-model planning** — Both models analyze your task in parallel and surface every ambiguous design decision before writing a line of code
- **Cross-model code review** — Reviewer flags are structured JSON: severity, location, and a plain-English fix hint — never a full rewrite
- **Surgical edits** — Reviewer produces exact code hunks; coder verifies each change individually
- **Model dialogue** — Disagreements trigger a negotiation (up to 3 rounds) before escalating to you
- **Per-file gate** — You review each generated file one at a time, request targeted changes, and accept when satisfied
- **Human arbitration** — Unresolved conflicts surface both positions clearly. Your decision is final and injected directly into the pipeline
- **Budget governor** — Per-provider spend caps with automatic mode switching so one heavy session can't exhaust your budget
- **Any two providers** — DeepSeek, Claude, GPT, Gemini, Mistral, OpenRouter, Groq, Together AI — mix and match freely

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

---

## How the pipeline works

Crucible runs through four phases. You only provide input at the marked gates — everything else runs automatically.

```
Phase 1 — Think
  Both models analyze your task independently in parallel.
  Each produces assumptions, questions, and a recommended approach.

Phase 1.5 — Align
  Models compare interpretations and flag architectural disagreements.
  Mismatches surface here, before a single line of code is written.

Phase 2 — Q&A + Spec                         ← Gate: you answer questions
  Required questions are presented once.
  You answer them and confirm the generated spec.
  Non-required questions are auto-answered using each model's recommendation.

Phase 3 — Generate + Review loop
  Primary generates code (streaming, with up to 2 self-check passes).
  Reviewer cross-validates and produces surgical edit hunks.
  Coder evaluates each hunk.
  Disputed hunks trigger model dialogue (up to 3 rounds).
  Unresolved disputes escalate to you.                ← Gate: arbitration

File Gate                                             ← Gate: per-file review
  Each generated file is presented one at a time.
  Send targeted feedback for changes, or accept.
  All files accepted → pipeline complete.
```

### Phase reference

| Phase | What happens | Your input? |
|---|---|---|
| `phase1_thinking` | Both models analyze the task in parallel | — |
| `phase1_5_alignment` | Models reconcile interpretations (max 2 rounds) | — |
| `phase2_questions` | Questions compiled; non-required ones auto-answered | — |
| `phase2_answering` | You answer required questions | **Yes** |
| `phase2_contradictions` | Contradiction check on your answers | — |
| `phase2_spec` | Deterministic spec built from questions + answers | — |
| `phase2_spec_confirm` | You confirm the spec before generation starts | **Yes** |
| `phase3_generating` | Primary streams code | — |
| `phase3_self_check` | Primary checks its own output (max 2 passes) | — |
| `phase3_reviewing` | Reviewer cross-validates against the spec | — |
| `phase3_reviewer_edit` | Reviewer produces surgical edit hunks | — |
| `phase3_coder_verify` | Primary evaluates reviewer's proposed changes | — |
| `phase3_dialogue` | Models negotiate disagreements (max 3 rounds) | — |
| `phase3_consensus` | Code promoted; file gate begins | — |
| `phase3_file_gate` | You review each file and request changes | **Yes** |
| `conflict_escalated` | Both positions shown; you decide | **Yes** |
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

Add API keys under **Settings → API Keys**.

| Provider | Models |
|---|---|
| DeepSeek | `deepseek-v4-pro`, `deepseek-v4-flash` |
| Anthropic | `claude-sonnet-4-6`, `claude-opus-4-7` |
| OpenAI | `gpt-4o`, `gpt-5-4`, `gpt-5-5` |
| Google | `gemini-pro`, `gemini-flash` |
| Mistral | `mistral-large`, `codestral` |
| OpenRouter | any model via openrouter.ai |
| Groq | fast inference models |
| Together AI | together.ai models |

### Budget governor

Crucible tracks spend per provider and switches modes automatically.

| Mode | Remaining budget | Effect |
|---|---|---|
| `FULL` | > 75% | Normal operation |
| `EFFICIENT` | 50–75% | HIGH-severity issues only; review rounds capped at 2 |
| `CONSERVATION` | 25–50% | Single-reviewer mode; R2 idle; `budget_degradation` event emitted |
| `CRITICAL` | < 25% | Budget gate before each file; spend + estimated cost shown |

Set per-provider monthly caps under **Settings → Budget**.

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

### File gate shows no code

**Cause:** The model's output wasn't parsed into named file blocks. Multi-file output must use `=== FILE: path ===` … `=== /FILE ===` delimiters.

**Fix:** For single-file tasks, the full response is stored as `output.txt` — this is expected.

---

### Files section is empty after the pipeline completes

**Cause:** Individual files are only written when you accept each file at the gate.

**Fix:** Refresh the Files page. If still empty, open the Conversation tab and confirm consensus was reached.

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
2. Extend `OpenAICompatibleAdapter` if the provider uses the OpenAI API shape (Groq, Together, DeepSeek, and Mistral all do). Otherwise extend `BaseAdapter` directly.
3. Implement `getProvider()` and any methods that need provider-specific behaviour. Everything else inherits.
4. Add your provider to the `switch` in `src/lib/adapters/index.ts`

---

## Contributing

```bash
git checkout -b feature/my-change
npx tsx test-logic.mts     # logic tests, no API keys needed
npx tsc --noEmit           # must be zero errors before opening a PR
```

- **New provider:** See [Adding a provider](#adding-a-provider) above — four steps, one file.
- **Bugs and features:** Open a GitHub issue.
- **Architecture questions:** Read `docs/decisions.md` for the reasoning behind every major design choice before proposing pipeline changes.

---

## License

MIT
