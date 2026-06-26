# Crucible

> Bring any AI. Build better code.

Crucible routes every coding task through two AI models from different companies. A **primary coder** generates the code. A **reviewer** from a different training family cross-validates it. Code only reaches you when both models agree.

You bring your own API keys. Crucible is the pipeline.

---

## Features

- **Pre-generation planning** — Both models analyze your task and surface every ambiguous decision before writing a single line of code
- **Cross-model review** — DeepSeek and Claude (or any two providers) have different training blind spots; what one misses the other catches
- **Surgical reviewer edits** — The reviewer produces specific code hunks, not a full rewrite; the coder verifies each change
- **Model dialogue** — When models disagree, they negotiate (up to 3 rounds) before escalating to you
- **Per-file gate** — You review each generated file individually and can request targeted changes before accepting
- **Human arbitration** — When models can't resolve a conflict, both positions are presented clearly and your decision is final
- **Budget governor** — Per-provider spend caps with four operating modes so a heavy session doesn't exhaust your monthly budget
- **Bring any model** — DeepSeek, Claude, GPT, Gemini, Mistral, OpenRouter, Groq, Together AI — one adapter per provider, zero pipeline changes

---

## Quick start

### 1. Install

```bash
git clone https://github.com/your-org/crucible
cd crucible
npm install
```

### 2. Set environment variables

```bash
cp .env.local.example .env.local
```

Open `.env.local` and fill in at minimum:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
DATABASE_URL=postgresql://...
ENCRYPTION_KEY=                        # openssl rand -hex 32
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 3. Run migrations

```bash
npx drizzle-kit push
```

### 4. Start the app

```bash
npm run dev
```

Open `http://localhost:3000`, sign in, add your API keys under **Settings**, create a project, and describe your task.

---

## Running with Docker (recommended for self-hosting)

Project output is persisted to a named Docker volume — it survives container restarts.

```bash
cp .env.local.example .env
# Fill in .env, then:
docker compose up -d
```

To view logs:

```bash
docker compose logs -f
```

The container writes all project data to `/data` (mounted as the `crucible_data` volume). To back up generated files, copy the volume contents.

---

## How the pipeline works

Crucible runs through four phases before delivering code. No code is generated until Phase 2 is complete.

```
[Phase 1 — Think]
Both models analyze your task independently in parallel.
Each produces structured assumptions, questions, and a recommended approach.

[Phase 1.5 — Align]
Models share their interpretations and reconcile differences.
Architectural mismatches are caught here before you see anything.

[Phase 2 — Q&A + Spec]          ← your only required input before generation
Questions are compiled and presented once. You answer them, confirm the
generated spec, and generation begins.

[Phase 3 — Generate + Review]
Primary generates code (streaming). Self-checks up to 2 passes.
Reviewer cross-validates and produces surgical edit hunks.
Coder evaluates each hunk. If disputed, models negotiate for up to 3 rounds.
Unresolved conflicts escalate to you.

[File Gate]                      ← review each file before it's saved
You review each generated file. Send feedback for targeted changes.
Accept when satisfied.
```

### Pipeline phases

| Phase | What happens | Human input? |
|---|---|---|
| `phase1_thinking` | Both models analyze the task in parallel | No |
| `phase1_5_alignment` | Models reconcile their interpretations (max 2 rounds) | No |
| `phase2_questions` | Questions compiled, non-required ones auto-answered | No |
| `phase2_answering` | You answer required questions | **Yes** |
| `phase2_contradictions` | Rule-based contradiction check on your answers | No |
| `phase2_spec` | Deterministic spec generated from questions + answers | No |
| `phase2_spec_confirm` | You confirm the spec before generation starts | **Yes** |
| `phase3_generating` | Primary streams code | No |
| `phase3_self_check` | Primary checks its own output (max 2 passes) | No |
| `phase3_reviewing` | Reviewer cross-validates against the spec | No |
| `phase3_reviewer_edit` | Reviewer produces surgical edit hunks | No |
| `phase3_coder_verify` | Primary evaluates reviewer's proposed changes | No |
| `phase3_dialogue` | Models negotiate disagreements (max 3 rounds) | No |
| `phase3_consensus` | Code promoted; file gate begins | No |
| `phase3_file_gate` | You review each file; request changes if needed | **Yes** |
| `conflict_escalated` | Both model positions shown; you decide | **Yes** |
| `complete` | All files accepted | — |

---

## Configuration

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable key |
| `CLERK_SECRET_KEY` | Yes | Clerk secret key |
| `CLERK_WEBHOOK_SECRET` | After deploy | Clerk webhook signing secret |
| `DATABASE_URL` | Yes | Neon PostgreSQL connection string |
| `ENCRYPTION_KEY` | Yes | AES-256-GCM key for stored API keys (`openssl rand -hex 32`) |
| `NEXT_PUBLIC_APP_URL` | Yes | Your app URL (e.g. `http://localhost:3000`) |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Sentry error tracking |
| `SENTRY_AUTH_TOKEN` | No | Sentry source map upload |
| `DATA_DIR` | No | Where to store project output (default: `./data`) |

### Clerk webhook setup

The webhook syncs new users into the database. Without it, users can sign in but the app can't retrieve their stored API keys.

1. Deploy the app
2. Clerk dashboard → **Webhooks** → **Add Endpoint**
3. URL: `https://your-domain.com/api/auth/webhook`
4. Subscribe to `user.created`
5. Copy the signing secret → set as `CLERK_WEBHOOK_SECRET`

### Supported model providers

Add your API keys under **Settings → API Keys** in the app.

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

**Recommended pairing:** DeepSeek V4 Pro as primary + Claude Sonnet 4.6 as reviewer. Different training families means genuine blind spot coverage. At current pricing, $25/month covers ~36M tokens vs Claude Pro's 1–2M.

### Budget governor

Crucible tracks spend per provider. Four operating modes:

| Mode | When | Effect |
|---|---|---|
| `FULL` | > 75% budget remaining | Normal operation |
| `EFFICIENT` | 50–75% remaining | Context compression, tighter prompts |
| `CONSERVATION` | 25–50% remaining | Aggressive compression, archive memory on demand |
| `CRITICAL` | < 25% remaining | User warned, graceful degradation options shown |

Set per-provider caps independently under **Settings → Budget**.

---

## Project structure

```
src/
├── app/
│   ├── (dashboard)/
│   │   ├── dashboard/         # Main pipeline view
│   │   ├── files/             # Generated files browser
│   │   └── settings/          # API keys + budget settings
│   └── api/
│       ├── auth/webhook/      # Clerk → database user sync
│       ├── credentials/       # API key CRUD (encrypted at rest)
│       ├── pipeline/
│       │   ├── start/         # Create session, begin pipeline
│       │   ├── stream/        # SSE — runs the pipeline, streams events
│       │   ├── message/       # Submit answers / confirm spec
│       │   ├── pause|play|stop/
│       │   ├── interrupt/     # Inject human override mid-pipeline
│       │   ├── resolve/       # Arbitrate an escalated conflict
│       │   ├── file-accept/   # Accept a file at the gate
│       │   └── file-feedback/ # Feedback → targeted file regeneration
│       ├── projects/          # Project list + output restore
│       ├── output/            # Consensus output for a session
│       ├── budget/            # Spend status and per-provider caps
│       └── conversation/      # Session event log
│
├── components/pipeline/
│   ├── PipelineView.tsx       # Phase router + progress strip + controls
│   ├── ThinkingPanel.tsx      # Phase 1 — model thinking cards
│   ├── AlignmentPanel.tsx     # Phase 1.5 — alignment messages
│   ├── QuestionsPanel.tsx     # Phase 2 — Q&A + contradiction resolution
│   ├── SpecPanel.tsx          # Phase 2 — spec confirmation
│   ├── GeneratingPanel.tsx    # Phase 3 — streaming code + step indicators
│   ├── DialoguePanel.tsx      # Phase 3 — coder ↔ reviewer negotiation
│   ├── ConflictPanel.tsx      # Human arbitration
│   ├── FileGatePanel.tsx      # Per-file review with feedback + accept
│   └── CompletePanel.tsx      # Done state with accepted file list
│
├── hooks/usePipeline.ts       # SSE connection + all pipeline actions
├── store/index.ts             # React useReducer store
│
├── lib/
│   ├── adapters/              # One file per provider, all implement ModelAdapter
│   │   ├── base.ts            # System prompts, parsers, BaseAdapter class
│   │   ├── openai-compatible.ts # Shared base for OpenAI-API providers
│   │   └── claude|deepseek|openai|google|mistral|openrouter.ts
│   ├── pipeline/
│   │   ├── orchestrator.ts    # createSession, runPipeline, pause/play/stop
│   │   └── phase*.ts          # One file per pipeline phase
│   ├── memory/                # Filesystem read/write, session log, memory tiers
│   ├── budget/index.ts        # Per-provider spend tracking
│   ├── crypto/index.ts        # AES-256-GCM key encryption
│   └── utils/tokens|retry.ts  # Token estimation, retry with backoff
│
└── types/index.ts             # All TypeScript types + Zod validation schemas
```

---

## Data storage

The database stores only two things: user identity (synced from Clerk) and encrypted API keys.

All project data — generated code, specs, session logs, checkpoints — lives on the filesystem at `DATA_DIR`.

```
./data/
└── projects/
    └── {projectId}/
        ├── output.json          # Restored when you reopen a project
        ├── output/              # Accepted files written after file gate
        ├── spec.json            # Locked after Phase 2 — never overwritten
        ├── session_log.jsonl    # Append-only event log
        ├── review_list.json     # Low-confidence flags accumulate here
        └── checkpoints/         # Snapshots at key milestones
```

### Database schema

```sql
-- User identity (Clerk is the source of truth)
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  plan          TEXT NOT NULL DEFAULT 'free',  -- free | indie | pro | team
  clerk_user_id TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API keys, encrypted at rest
CREATE TABLE api_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,            -- AES-256-GCM, never plaintext
  is_valid      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
);
```

---

## Adding a new model provider

1. Create `src/lib/adapters/your-provider.ts`
2. Extend `BaseAdapter` (or `OpenAICompatibleAdapter` if it uses the OpenAI API shape)
3. Implement the `ModelAdapter` interface — all 9 methods
4. Register it in `src/lib/adapters/index.ts`

Zero changes to the pipeline, phases, or routing logic.

The interface (in `src/types/index.ts`):

```typescript
interface ModelAdapter {
  think(taskDescription: string, contextText?: string): Promise<ThinkingOutput>
  chat(round: 1 | 2, taskDescription: string, myThinking: ThinkingOutput,
    otherThinking: ThinkingOutput, previousMessages?: AlignmentMessage[],
    contextText?: string): Promise<AlignmentMessage>
  generate(prompt: string, ctx: PipelineContext): AsyncGenerator<string>
  selfCheck(code: string, spec: SpecDocument, pass: 1 | 2,
    previousIssues?: SelfCheckIssue[]): Promise<SelfCheckOutput>
  review(code: string, spec: SpecDocument, round: number,
    previousReview?: ReviewPayload): Promise<ReviewPayload>
  reviewerEdit(code: string, spec: SpecDocument,
    review: ReviewPayload, round: number): Promise<ReviewEdit>
  coderVerify(originalCode: string, edit: ReviewEdit,
    mergedCode: string, review: ReviewPayload): Promise<CoderVerification>
  coderDialogue(code: string, dialogue: DialogueSummary,
    verification: CoderVerification): Promise<string>
  reviewerDialogue(code: string, dialogue: DialogueSummary,
    review: ReviewPayload): Promise<{ response: string; resolved: boolean }>
  getProvider(): Provider
  getModelId(): string
  estimateCost(inputTokens: number, outputTokens: number): number
}
```

---

## Running tests

```bash
# Unit tests (no API keys needed)
npm test

# Watch mode
npm run test:watch

# Logic tests — 52 tests, no API calls
npx tsx test-logic.mts

# Full pipeline integration test (requires real API keys)
DEEPSEEK_API_KEY=sk-... ANTHROPIC_API_KEY=sk-... npx tsx test-pipeline.mts

# Playwright E2E tests
npm run test:e2e
```

---

## Troubleshooting

### "Session not found" after page refresh

Pipeline state is held in-process memory. If the server restarts (e.g. during `npm run dev` hot reload after a file change), in-flight sessions are lost. Start a new session.

### Pipeline stalls and shows "auto-reconnecting…"

The SSE stream reconnects automatically when a pipeline phase closes mid-stream. If it reconnects more than 10 times without reaching a human gate, you'll see an error. This usually means the model API is returning empty responses. Check:
- Your API key is valid (Settings → API Keys)
- The model you selected is available from that provider
- You haven't hit the provider's rate limit

### Generated code panel is blank during Phase 3

The code streams token by token. If you see the "Generating…" state but no text appears, the model hasn't emitted its first token yet. Reasoning models (e.g. DeepSeek V4 Pro) sometimes think silently for up to 5 minutes before streaming. Wait it out or stop and retry with a faster model.

### "Encryption key mismatch" when loading API keys

Your `ENCRYPTION_KEY` changed after keys were stored. Keys are AES-256-GCM encrypted with that key — if the key changes, existing encrypted values can't be decrypted. Delete the affected credentials in Settings and re-add them.

### File gate shows no code

This happens when `generatedFiles` was not parsed from the model's output. The model must use `=== FILE: path ===` ... `=== /FILE ===` delimiters for multi-file output, or the entire response is stored as `output.txt`. Check your generation prompt in the system prompts inside `src/lib/adapters/base.ts`.

### Files section is empty after pipeline completes

The Files section reads from `data/projects/{id}/output/` — individual files written when you accept each file at the gate. If the pipeline exited before the file gate (e.g. due to an error or unexpected exit), files are stored in `output.json` but the `output/` directory is never written.

This is handled automatically: on the next visit to the Files page, the API detects the missing `output/` directory and hydrates it from `output.json`. If the Files section still shows empty after a refresh, check that consensus was actually reached by looking at the pipeline output in the conversation tab.

### "Pipeline exited unexpectedly" during reviewer edit phase

The reviewer embed edits directly in a structured text format (`=== HUNK ===` delimiters). If you were using an older version of Crucible that used JSON for reviewer edits, the parser would fail on Python or shell code containing unescaped backslashes and double quotes. The current version uses a delimiter format that is not affected by code content.

### Task description too long error

The task description field accepts up to 50,000 characters. The context field (for pasting existing code) accepts up to 40,000 characters. If you're hitting limits, move large code pastes to the context field.

### OpenAI models error with "max_tokens too large"

The generation step is capped at 16,384 completion tokens — the maximum supported by current GPT-4o models. If you're using a newer model with a higher limit, update `max_tokens` in `src/lib/adapters/openai-compatible.ts` line 173.

### Docker container exits immediately

Check that all required environment variables are set in your `.env` file:

```bash
docker compose config   # shows the resolved config
docker compose logs     # shows the startup error
```

---

## API key security

Keys stored in the database are encrypted with AES-256-GCM using `ENCRYPTION_KEY`. They are:

- Never logged anywhere (server or client)
- Never sent to the browser in any response
- Decrypted only at the moment of an API call, in server memory only
- Validated with a real API call before being stored (`is_valid = true`)

---

## Token pricing reference (June 2026, per million tokens)

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

## Contributing

1. Fork the repo
2. Create a branch: `git checkout -b feature/my-change`
3. Make your changes and run `npm test`
4. Open a pull request

For new model adapters, see [Adding a new model provider](#adding-a-new-model-provider) above.

For bugs and feature requests, open an issue.

---

## License

MIT
