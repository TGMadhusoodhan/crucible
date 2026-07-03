@AGENTS.md
# Crucible — CLAUDE.md

> **Bring any AI. Build better code.**
> *"Your models. Your code. Cross-examined."*

---

## MEMORY INSTRUCTIONS — READ THIS FIRST BEFORE ANYTHING ELSE

These instructions govern how you maintain context across this entire project.
Follow them on every single session without exception.

### On Every Session Start
1. Read this entire CLAUDE.md file completely before writing any code
2. Read `docs/build_log.md` to understand exactly where the build is
3. Read `docs/decisions.md` to understand every decision already made
4. Check `docs/current_step.md` to know which step you are on
5. Do not assume anything — read the files and confirm state before acting

### On Every Session End (or when asked to save)
Update these files before stopping:
```
docs/build_log.md      — append what was built this session
docs/current_step.md   — update which step is now active
docs/decisions.md      — append any new decisions made
```

### These Files Are Your Memory
```
docs/
├── build_log.md       # Running log of everything built, in order
├── current_step.md    # Single source of truth: what step are we on
├── decisions.md       # Every architectural decision and why
├── open_issues.md     # Bugs, blockers, things to revisit
└── session_notes.md   # Scratch pad for current session context
```

Create the docs/ folder and all five files at the very start of STEP 1.
Initialize them with the current project state before writing any other code.

### Build Log Format (append only, never overwrite)
```markdown
## Session [DATE] [TIME]
### Completed
- [exactly what was built]
### Files Created
- [file path] — [one line description]
### Files Modified
- [file path] — [what changed and why]
### Decisions Made
- [decision] — [reason]
### Left Off At
- [exact state, what is next]
```

### Current Step File Format (overwrite on update)
```markdown
# Current Build Step
Step: [number and name]
Status: [IN PROGRESS / COMPLETE]
Started: [date]
Last Updated: [date]

## What Is Done In This Step
- [list]

## What Remains In This Step
- [list]

## Blockers
- [any blockers or empty]
```

### Rules For Context Management
- If you are unsure what was built: READ build_log.md, do not guess
- If you are unsure about a decision: READ decisions.md, do not reinvent
- If context window is getting long: summarize completed work into build_log.md
- Never start a new session by asking "where were we" — read the files
- Never duplicate work — check build_log.md before building anything
- If a file already exists and looks correct: verify it, do not rewrite it

### When Context Window Gets Full
When you notice the conversation is getting very long:
1. Write a full session summary to docs/build_log.md
2. Update docs/current_step.md with exact current state
3. Note any open issues in docs/open_issues.md
4. Tell the user: "Context is getting long. Start a new Claude Code
   session — I have saved full state to docs/. Resume by saying:
   'Resume Crucible build' and I will read the files and continue."

This is how Crucible builds itself without losing context.
The docs/ folder IS the memory. Always write to it. Always read from it.

---

## What Is Crucible

Crucible is a **model-agnostic multi-LLM coding orchestration platform**. It solves the core problem of single-model coding: one model cannot reliably catch its own mistakes. Crucible routes every coding session through two models from different AI families — a **primary coder** and a **reviewer** — and only promotes code to the output layer when both models reach consensus.

The user brings their own API keys. Crucible is the pipeline intelligence. The models are pluggable.

---

## The Core Problem Being Solved

Single-model coding has four compounding problems:
1. **Token exhaustion** — Claude Pro throttles invisibly after heavy sessions with no warning
2. **Single model blind spots** — every model has systematic training gaps it cannot self-detect
3. **No cross-validation** — the same model that generated the code is also evaluating it
4. **Cost vs quality tradeoff** — Opus exhausts fast, Sonnet misses more, no middle ground

Crucible solves all four by splitting roles across two models from different training families.

---

## How The Pipeline Works

The pipeline is a 4-phase resumable state machine. Each human-input gate closes
the SSE stream; the client reconnects when the user acts.

```
User gives task description + optional codebase context
        │
        ▼
PHASE 1 — Think (parallel, no human input)
  Primary model  ─┐  each independently produces:
  Reviewer model ─┘  understood_as, assumptions[], questions[], approach, risks
        │
        ▼
PHASE 1.5 — Align (skipped if models agree, max 2 rounds)
  Models exchange interpretations and reconcile differences.
  Architectural mismatches surfaced here before you see anything.
        │
        ▼
PHASE 2 — Q&A + Spec
  [2a] Questions compiled and merged from both models + second-pass checklist
  [2b] ← HUMAN: answer required questions (non-required auto-answered)
  [2c] Rule-based contradiction check on your answers
  [2d] Deterministic spec generated from questions + answers
  [2e] ← HUMAN: confirm spec before generation starts
        │
        ▼
PHASE 3 — Generate + Review loop (rounds 1–3, then escalate)
  [3a] Primary generates code (streaming) + self-check (max 2 passes)
  [3b] Reviewer cross-validates → structured JSON flags only, never full code
  [3c] Reviewer produces surgical edit hunks (=== HUNK === delimiters)
  [3d] Coder evaluates each hunk — accepts or disputes
  [3e] If disputed: models negotiate (max 3 dialogue rounds)
  [3f] If still unresolved: ← HUMAN arbitration
        │
        ▼
FILE GATE — per-file review
  Each generated file presented one at a time.
  ← HUMAN: send feedback for targeted changes, or accept.
  All files accepted → pipeline complete.
        │
        ▼
PERSISTENCE — ./data/projects/{id}/
  output.json (restored when project reopened on any session)
  output/     (individual files written after each file-gate accept)
  spec.json   (locked after Phase 2 — never overwritten)
  session.jsonl (append-only event log)
  checkpoints/ (snapshots at milestones)
```

---

## Critical Architectural Rules

These rules must never be violated anywhere in the codebase:

### 1. Reviewer Returns Pseudo-Code Only — NEVER Full Code
```
WRONG: Reviewer rewrites DeepSeek's function
RIGHT: Reviewer says "loop on line 47 fails on empty array.
        Suggest: check arr.length > 0 before iteration"

Why: If reviewer generates full code it becomes a second primary
     and the reviewer API budget exhausts in hours.
     Pseudo-code hints cost ~50-100 tokens per pass.
     Full code rewrites cost ~2000 tokens per pass.
```

### 2. Human Command Is Always Top Priority
```
When human types in conversation layer:
INJECT as: "HUMAN OVERRIDE: [message]
            All prior reasoning is subordinate to this.
            Acknowledge explicitly before continuing."

Models must explicitly acknowledge before resuming.
This prevents the "noted, however..." failure mode.
```

### 3. Dialogue Before Escalation — But Never More Than 3 Rounds
```
Review failure → reviewer edits → coder verifies → if disputed:
  Round 1 coder message → reviewer response
  Round 2 coder message → reviewer response
  Round 3 coder message → reviewer response (final)
  Still unresolved → HUMAN escalation

Format at escalation: "Coder: [position]. Reviewer: [position]. Your call?"
Human decision → injected as HUMAN OVERRIDE → pipeline resumes.

Why 3 rounds: unlimited rounds = models reasoning each other into corners.
3 rounds surfaces genuine disagreements without burning token budget.
```

### 4. Output Layer Only Receives Consensus Code
```
Nothing reaches the output layer without consensus: true
from the reviewer's structured JSON response.
The output layer is sacred — it is what the user ships from.
```

### 5. API Keys Never Leave the Server Encrypted
```
Keys stored encrypted (AES-256) in database.
Never logged anywhere.
Never sent to frontend.
Never stored in plaintext anywhere.
Decrypted only at the moment of API call, in memory only.
```

---

## Model Architecture

### The Adapter Pattern (CRITICAL — read before touching model code)

Every model implements the same interface. The pipeline never knows or cares which company made the model underneath.

```typescript
interface ModelAdapter {
  // Phase 1 — independent silent thinking
  think(taskDescription: string, contextText?: string): Promise<ThinkingOutput>

  // Phase 1.5 — alignment chat (max 2 rounds, enforced at call site)
  chat(round: 1 | 2, taskDescription: string, myThinking: ThinkingOutput,
    otherThinking: ThinkingOutput, previousMessages?: AlignmentMessage[],
    contextText?: string): Promise<AlignmentMessage>

  // Phase 3 — streaming code generation
  generate(prompt: string, ctx: PipelineContext): AsyncGenerator<string>

  // Phase 3 — coder self-checks own output (max 2 passes, enforced in phase3-generate.ts)
  selfCheck(code: string, spec: SpecDocument, pass: 1 | 2,
    previousIssues?: SelfCheckIssue[]): Promise<SelfCheckOutput>

  // Phase 3 — reviewer cross-validates (JSON flags only — NEVER full code)
  review(code: string, spec: SpecDocument, round: number,
    previousReview?: ReviewPayload): Promise<ReviewPayload>

  // Phase 3b — reviewer produces surgical edit hunks (=== HUNK === format)
  reviewerEdit(code: string, spec: SpecDocument,
    review: ReviewPayload, round: number): Promise<ReviewEdit>

  // Phase 3b — coder evaluates reviewer's hunks
  coderVerify(originalCode: string, edit: ReviewEdit,
    mergedCode: string, review: ReviewPayload): Promise<CoderVerification>

  // Phase 3b dialogue
  coderDialogue(code: string, dialogue: DialogueSummary,
    verification: CoderVerification): Promise<string>
  reviewerDialogue(code: string, dialogue: DialogueSummary,
    review: ReviewPayload): Promise<{ response: string; resolved: boolean }>

  getProvider(): Provider
  getModelId(): string
  estimateCost(inputTokens: number, outputTokens: number): number
}
```

Implemented adapters (all in `src/lib/adapters/`):
- `ClaudeAdapter` — Claude Sonnet 4.6 / Opus 4.8
- `OpenAIAdapter` — GPT-4o / GPT-5.4 / GPT-5.5
- `DeepSeekAdapter` — DeepSeek V4 Pro / V4 Flash (extends OpenAICompatibleAdapter)
- `GoogleAdapter` — Gemini Pro / Flash
- `MistralAdapter` — Mistral Large / Codestral (extends OpenAICompatibleAdapter)
- `OpenRouterAdapter` — any model via OpenRouter (extends OpenAICompatibleAdapter)
- `GroqAdapter` — fast inference (extends OpenAICompatibleAdapter)
- `TogetherAdapter` — Together AI (extends OpenAICompatibleAdapter)

New providers = new adapter class extending `BaseAdapter` or `OpenAICompatibleAdapter`.
Override `generate()` for provider-specific streaming; all other methods inherit.
Zero changes to the pipeline.

### Recommended Default Configuration
```
Primary:  DeepSeek V4 Pro  ($0.435/$0.87 per 1M tokens)
          80.6% SWE-bench Verified — beats Claude Sonnet on raw coding
          Used for: all code generation

Reviewer: Claude Sonnet 4.6 ($3.00/$15.00 per 1M tokens)
          OR GPT-4o ($2.50/$10.00 per 1M tokens)
          Different training family = genuine cross-validation
          Used for: logic review, architecture, conflict arbitration, final gate
```

### Why This Default
DeepSeek V4 Pro scores 80.6% on SWE-bench Verified vs Claude Sonnet at 79.6%.
DeepSeek costs $0.565/M blended vs Claude at $6.60/M blended.
Claude reviewing DeepSeek output = different training distribution = real blind spot coverage.
$20 DeepSeek + $5 Claude = 36.2M total tokens vs Claude Pro's 1-2M.

---

## Memory System

### Two-Tier Memory (Never collapse these into one)

```typescript
interface ProjectMemory {
  active: {
    // Always injected every session — keep under 8k tokens
    current_module: string
    open_questions: string[]
    file_structure: FileTree
    recent_decisions: Decision[]
    current_tech_stack: string[]
    unresolved_conflicts: Conflict[]
  }
  archive: {
    // Injected only when relevant — can be large
    completed_modules: CompletedModule[]
    resolved_decisions: Decision[]
    earlier_architecture: string[]
    deprecated_approaches: string[]
  }
}
```

### Session History
- Load last **40,000 tokens** of session log on resume
- NOT last 50 messages — token count, not message count
- Long code-heavy sessions have fewer messages but same token budget

### Compression Triggers (archive memory)
- Module marked complete → compress to interface description only
- Conflict resolved → compress to "Decision: X because Y"
- Code version superseded → drop old version, keep final only
- Active memory exceeds 8k tokens → move oldest decisions to archive

---

## Budget Governor

Four operating modes based on remaining monthly budget:

```
FULL (>75% remaining):       Normal pipeline, no restrictions
EFFICIENT (50-75%):          Context compression, tighter prompts
CONSERVATION (25-50%):       Aggressive compression, archive on-demand only
CRITICAL (<25%):             User warned, options presented, graceful degradation
```

Budget dashboard always visible to user:
- Monthly budget and amount spent
- Days elapsed, daily average, month-end projection
- Per-session token usage
- Estimated cost to complete current module

---

## Local File Structure

```
./data/                              # controlled by DATA_DIR env var (default ./data)
├── crucible.db                      # SQLite — projects, credentials, budget
├── crucible.db-shm                  # SQLite WAL shm
├── crucible.db-wal                  # SQLite WAL log
└── projects/
    └── {project-id}/
        ├── output.json              # ConsensusOutput + spec — restored on reopen
        ├── output/                  # Individual accepted files (written at file gate)
        │   └── {relative/path}
        ├── spec.json                # Write-once after Phase 2 confirm
        ├── session.jsonl            # Append-only event log
        ├── reviews.jsonl            # Reviewer flag history per round
        └── checkpoints/
            └── {timestamp}_{trigger}.json   # Snapshots at milestones
```

Checkpoint triggers: `module_complete`, `conflict_resolved`, `human_confirm`, `manual`.
Each checkpoint = full ConsensusOutput snapshot + one-paragraph summary.

Pipeline session state (in-flight phases, partial output) lives in a global in-process
Map (`global.__sessionStore`). It survives Next.js hot reloads but not a full server
restart. Completed output is always recoverable from `output.json`.

---

## Tech Stack

```
FRONTEND:        Next.js 16.2.6 (App Router) + TypeScript strict + Tailwind CSS v4
BACKEND:         Next.js API Routes (same repo)
DATABASE:        SQLite via better-sqlite3 + Drizzle ORM (./data/crucible.db)
SESSION STATE:   In-process global Map (survives hot reload, not restarts)
AUTH:            None — single-user local app (userId hardcoded to 'local')
HOSTING:         Docker (primary) — docker-compose.yml, data volume mounted at /data
MONITORING:      Sentry (optional)
```

There is no external database, no Redis, no Clerk, no Vercel dependency.
The Docker container is the complete deployment unit.

---

## Database Schema (Complete — Do Not Add Tables Without Discussion)

SQLite. Managed by Drizzle ORM (`src/lib/db/schema.ts`). Auto-created on first run.

```sql
-- Project configuration (model pairing stored per-project)
CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  primary_provider  TEXT NOT NULL,
  primary_model_id  TEXT NOT NULL,
  reviewer_provider TEXT NOT NULL,
  reviewer_model_id TEXT NOT NULL,
  created_at        INTEGER NOT NULL       -- unix ms
);

-- API keys, AES-256-GCM encrypted. One row per provider.
CREATE TABLE api_credentials (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL UNIQUE,     -- no user_id — single-user app
  encrypted_key TEXT NOT NULL,
  is_valid      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- Per-provider monthly spend (replaces Redis incrbyfloat keys)
CREATE TABLE budget_spend (
  provider   TEXT NOT NULL,
  year_month TEXT NOT NULL,               -- 'YYYY-MM'
  spend_usd  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, year_month)
);

-- User-set caps per provider
CREATE TABLE provider_caps (
  provider TEXT PRIMARY KEY,
  cap_usd  REAL NOT NULL
);

-- Per-session cost accumulation
CREATE TABLE session_costs (
  session_id TEXT PRIMARY KEY,
  cost_usd   REAL NOT NULL DEFAULT 0,
  tokens     INTEGER NOT NULL DEFAULT 0
);
```

Billing table is intentionally excluded from V1. Add only when Stripe integration begins.
Users table removed — single-user app, no auth, userId is always 'local'.

---

## Supported Providers

```typescript
type Provider =
  | 'anthropic'    // claude-sonnet-4-6, claude-opus-4-8
  | 'openai'       // gpt-4o, gpt-5-4, gpt-5-5
  | 'deepseek'     // deepseek-v4-pro, deepseek-v4-flash
  | 'google'       // gemini-pro, gemini-flash
  | 'mistral'      // mistral-large, codestral
  | 'openrouter'   // any model via openrouter.ai
  | 'groq'         // fast inference models
  | 'together'     // together.ai models
```

New providers = new adapter class extending `BaseAdapter` or `OpenAICompatibleAdapter`.
Zero changes to pipeline.

---

## API Routes Structure

```
# Credentials (API keys, encrypted at rest)
GET    /api/credentials              # List connected providers
POST   /api/credentials              # Add + validate new API key
DELETE /api/credentials/:id          # Remove API key

# Models
GET    /api/models/:provider         # Fetch model list from provider's /v1/models

# Projects
GET    /api/projects                 # List all projects
POST   /api/projects                 # Create new project
GET    /api/projects/:id             # Get project config
GET    /api/projects/:id/output      # Restore last consensus output for project

# Pipeline — session lifecycle
POST   /api/pipeline/start           # Create session + begin Phase 1
GET    /api/pipeline/stream          # SSE: runs pipeline, streams events (closes at gates)
POST   /api/pipeline/pause           # Pause (sets control signal, closes stream)
POST   /api/pipeline/play            # Resume (clears control signal, client reconnects)
POST   /api/pipeline/stop            # Stop (terminal — start new session to retry)

# Pipeline — human-input gates
POST   /api/pipeline/message         # answers | confirm_spec (advances phase, client reconnects)
POST   /api/pipeline/interrupt       # Inject HUMAN OVERRIDE mid-pipeline
POST   /api/pipeline/resolve         # Arbitrate escalated conflict
POST   /api/pipeline/file-accept     # Accept current file at gate, advance to next
POST   /api/pipeline/file-feedback   # Targeted file feedback → model regenerates → returns code

# Output + conversation
GET    /api/output/:sessionId        # Full ConsensusOutput for a session
GET    /api/conversation/:sessionId  # Event log (view=events|timeline|summary, since=, eventId=)

# Budget
GET    /api/budget                   # Spend status + per-provider breakdown
PATCH  /api/budget                   # Set per-provider cap { provider, capUsd }

# Health
GET    /api/health                   # Liveness probe
```

---

## Environment Variables Required

```bash
# ── REQUIRED ───────────────────────────────────────────────────────────────────

# AES-256-GCM key for stored API keys. Generate ONCE: openssl rand -hex 32
# CRITICAL: Never change this after first run — all stored API keys become unreadable.
ENCRYPTION_KEY=

# ── OPTIONAL ───────────────────────────────────────────────────────────────────

# Where to store project data (default: ./data, mounted as volume in Docker)
DATA_DIR=./data

# Sentry error reporting — leave blank to disable
NEXT_PUBLIC_SENTRY_DSN=
SENTRY_AUTH_TOKEN=

# Used by OpenRouter for HTTP-Referer header (default: http://localhost:3000)
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

No external services required. No DATABASE_URL, no Redis URL, no Clerk keys.
The SQLite database auto-creates at `$DATA_DIR/crucible.db` on first start.

---

## Business Model

```
FREE TIER:
├── Full pipeline features (no capability gating)
├── 3 projects maximum
├── 30 day session history
├── Community support
└── Upgrade trigger: project 4 → show savings number → convert

INDIE ($12/month):
├── Unlimited projects
├── 90 day session history
└── Email support

Future tiers (Pro $24, Team $49) added when user demand justifies.
```

---

## Pricing Reference (June 2026, for budget governor)

```typescript
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'deepseek-v4-pro':    { input: 0.435, output: 0.87  },
  'deepseek-v4-flash':  { input: 0.14,  output: 0.28  },
  'claude-sonnet-4-6':  { input: 3.00,  output: 15.00 },
  'claude-opus-4-7':    { input: 5.00,  output: 25.00 },
  'gpt-4o':             { input: 2.50,  output: 10.00 },
  'gpt-5-4':            { input: 2.50,  output: 15.00 },
  'gpt-5-5':            { input: 5.00,  output: 30.00 },
  'gemini-pro':         { input: 1.25,  output: 5.00  },
  'mistral-large':      { input: 2.00,  output: 6.00  },
  'qwen3-coder-next':   { input: 0.11,  output: 0.80  },
} // prices per million tokens
```

---

## What Has Been Deliberately Left Out of V1

Do not add these without explicit discussion:

```
- Billing / Stripe integration (no users paying yet)
- Multi-user / auth layer (currently single-user, userId = 'local')
- Local model / Ollama integration (removed 2026-07-03 — not needed for V1)
- Archive memory compression engine (manual for now)
- Checkpoint automation (manual save only)
- Team / multi-seat features
- Advanced analytics dashboard
- VS Code extension
- Desktop app (Tauri/Electron)
- Mobile support
- Model fine-tuning
- Shared project links
```

---

## Code Style Rules

```
- TypeScript strict mode, no any
- Zod for all external data validation
- All API routes return consistent shape:
    { success: boolean, data?: T, error?: string }
- All model calls are async/await with try-catch
- Never log API keys, tokens, or user code
- Error messages to user are always human-readable
- No console.log in production — use `src/lib/debug.ts` (gated by NODE_ENV; set CRUCIBLE_DEBUG=1 to enable in prod)
```

---

## When In Doubt

The full decision log with reasoning is in `docs/decisions.md`.
The running build log is in `docs/build_log.md`.
The pipeline is the product. The models are pluggable.
When adding any feature ask: does this serve the pipeline or distract from it?