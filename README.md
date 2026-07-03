# Crucible

> Bring any AI. Build better code.

Crucible routes every coding task through two AI models from different companies. A **primary coder** generates the code. A **reviewer** from a different training family cross-validates it. Code only reaches you when both models agree.

You bring your own API keys. Crucible is the pipeline.

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

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/your-org/crucible
cd crucible
npm install
```

### 2. Set your encryption key

```bash
cp .env.example .env.local
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env.local
```

> **Important:** Never change `ENCRYPTION_KEY` after the first run. All API keys you store are encrypted with it. If it changes, they become unreadable and must be re-entered.

No external database, cache, or auth service is required. SQLite creates itself on first start.

### 3. Start the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 4. Add API keys and create a project

1. Go to **Settings → API Keys** and add keys for at least two providers
2. Click **New project** and choose your primary coder and reviewer models
3. Describe your task and click **Start pipeline**

The pipeline runs automatically until it needs your input (answering questions, confirming the spec, reviewing files). You'll see exactly what each model produced at every step.

**Recommended first pairing:** DeepSeek V4 Pro (primary) + Claude Sonnet 4.6 (reviewer). Different training families, genuine blind spot coverage, and ~36M tokens for $25/month vs Claude Pro's 1–2M.

---

## Running with Docker

Docker is recommended for self-hosting — project output persists across container restarts in a named volume.

```bash
cp .env.example .env
# Add ENCRYPTION_KEY to .env, then:
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
| `ENCRYPTION_KEY` | **Yes** | AES-256-GCM key for stored API keys. Generate with `openssl rand -hex 32`. Never change after first run. |
| `DATA_DIR` | No | Where to store project data (default: `./data`) |
| `NEXT_PUBLIC_APP_URL` | No | App URL — used by OpenRouter for HTTP-Referer (default: `http://localhost:3000`) |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Sentry error tracking DSN |
| `SENTRY_AUTH_TOKEN` | No | Sentry source map upload token |

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
| `EFFICIENT` | 50–75% | Context compression, tighter prompts |
| `CONSERVATION` | 25–50% | Aggressive compression; archive memory on demand |
| `CRITICAL` | < 25% | Warning shown; graceful degradation options presented |

Set per-provider monthly caps under **Settings → Budget**.

---

## Data storage

Everything lives under `DATA_DIR` (`./data` by default). No external services.

```
./data/
├── crucible.db              # SQLite — projects, encrypted API keys, budget
└── projects/
    └── {projectId}/
        ├── output.json      # Restored automatically when you reopen a project
        ├── output/          # Individual accepted files (written at the file gate)
        ├── spec.json        # Locked after Phase 2 — never overwritten
        ├── session.jsonl    # Append-only event log
        ├── reviews.jsonl    # Reviewer flag history per round
        └── checkpoints/     # Snapshots at key milestones
```

---

## API key security

API keys stored in the database are encrypted with AES-256-GCM using `ENCRYPTION_KEY`. They are:

- Never logged on the server or sent to the browser
- Decrypted only at the moment of an API call, in server memory only
- Validated with a live API call before being marked valid and stored

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

**Cause:** `ENCRYPTION_KEY` was changed after API keys were stored. All keys are AES-256-GCM encrypted with the value set at storage time.

**Fix:** Delete the affected credentials in **Settings → API Keys** and re-enter them. Encrypted values cannot be recovered after a key change.

---

### File gate shows no code

**Cause:** The model's output wasn't parsed into named file blocks. Multi-file output must use `=== FILE: path ===` … `=== /FILE ===` delimiters.

**Fix:** For single-file tasks, the full response is stored as `output.txt` — this is expected. For multi-file tasks, check the Conversation tab to see the raw model output.

---

### Files section is empty after the pipeline completes

**Cause:** Individual files under `data/projects/{id}/output/` are only written when you accept each file at the gate. If the pipeline ended before the file gate, the directory is empty.

**Fix:** Refresh the Files page. The API hydrates `output/` from `output.json` on the next request. If it's still empty, open the Conversation tab and confirm consensus was reached.

---

### Task description too long

**Cause:** Task descriptions are capped at 50,000 characters; the context field at 40,000 characters.

**Fix:** Move large code pastes to the **Context** field. If you're still hitting the limit, split the task into phases.

---

### OpenAI models error with "max_tokens too large"

**Cause:** The generation step requests 16,384 completion tokens. Some older GPT-4o model variants have a lower cap.

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

See any of the existing short adapters (`deepseek.ts`, `groq` inside `index.ts`) for working examples.

---

## Contributing

```bash
git checkout -b feature/my-change
npx tsx test-logic.mts     # 52 logic tests, no API keys needed
npx tsc --noEmit           # must be zero errors before opening a PR
```

- **New provider:** See [Adding a provider](#adding-a-provider) above — four steps, one file.
- **Bugs and features:** Open a GitHub issue.
- **Architecture questions:** Read `docs/decisions.md` for the reasoning behind every major design choice before proposing pipeline changes.

---

## License

MIT
