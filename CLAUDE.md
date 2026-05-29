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

```
User gives project spec or coding task
        |
        v
CONVERSATION LAYER (staging — not shown to user by default)
├── Primary model generates code
├── Reviewer model returns structured JSON flags only
│     { consensus: bool, critical_bugs: [], logic_errors: [],
│       edge_cases_missed: [], pseudo_code_hints: [] }
├── If consensus: TRUE → code promoted to Output Layer
├── If consensus: FALSE → IMMEDIATE human escalation
│     Clean summary: "Primary thinks X, Reviewer thinks Y"
│     Human answers → both models anchor to human answer
│     Explicit acknowledgment required before continuing
└── Human can intervene at any point:
      TYPE anywhere → priority interrupt to both models
      EDIT any model's prompt → re-run from that point, log edit
      PAUSE → freeze state, check for commands on PLAY
      STOP → kill pipeline, save all state
        |
        v
OUTPUT LAYER (what user builds from)
├── Consensus-validated code only
├── Clean diff from previous version
├── Change log: what was debated, resolved, human decided
└── Full conversation trace available on demand
        |
        v
PERSISTENCE LAYER (local filesystem)
├── ~/.crucible/projects/{project_name}/
│     memory.json (active + archive memory)
│     session_log.jsonl (append-only, never deleted)
│     checkpoints/ (milestone snapshots)
│     output/ (consensus-validated code files)
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

### 3. Conflict = Immediate Human Escalation
```
No round-based debate between models.
First conflict detected → surface to human immediately.
Format: "Primary: [one line]. Reviewer: [one line]. Your call?"
Human answers → both models anchor → pipeline resumes.
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
  generate(prompt: string, context: ConversationContext): AsyncGenerator<string>
  review(code: string, context: ConversationContext): Promise<ReviewPayload>
  getProvider(): Provider
  getModelId(): string
  estimateCost(inputTokens: number, outputTokens: number): number
}

interface ReviewPayload {
  consensus: boolean
  critical_bugs: string[]
  logic_errors: string[]
  edge_cases_missed: string[]
  pseudo_code_hints: string[]
  reasoning: string
}
```

Implemented adapters:
- `DeepSeekAdapter` — DeepSeek V4 Pro / V4 Flash
- `ClaudeAdapter` — Claude Sonnet 4.6 / Opus 4.7
- `OpenAIAdapter` — GPT-4o / GPT-5.4 / GPT-5.5
- `GoogleAdapter` — Gemini Pro / Flash
- `MistralAdapter` — Mistral Large / Codestral
- `OpenRouterAdapter` — any model via OpenRouter

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
~/.crucible/
└── projects/
    └── {project-id}/
        ├── memory.json          # Two-tier memory (active + archive)
        ├── session_log.jsonl    # Append-only, every message timestamped
        ├── config.json          # Project settings, model config
        ├── checkpoints/
        │   └── {timestamp}_{trigger}.json  # Snapshots
        └── output/
            └── {filename}       # Consensus-validated code files
```

Checkpoint triggers: module complete, conflict resolved, human confirms, manual save.
Each checkpoint = output snapshot + one paragraph summary.

---

## Tech Stack

```
FRONTEND:   Next.js 14 (App Router) + TypeScript + Tailwind CSS
BACKEND:    Next.js API Routes (same repo, one Vercel deployment)
DATABASE:   Neon PostgreSQL (2 tables only: users, api_credentials)
AUTH:       Clerk
CACHE:      Upstash Redis (pipeline state + rate limiting)
LOCAL:      User filesystem via File System Access API
HOSTING:    Vercel
MONITORING: Sentry
```

---

## Database Schema (Complete — Do Not Add Tables Without Discussion)

```sql
-- Table 1
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,
  plan        TEXT NOT NULL DEFAULT 'free'
                   CHECK (plan IN ('free', 'indie', 'pro', 'team')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  clerk_user_id TEXT NOT NULL UNIQUE
);

-- Table 2
CREATE TABLE api_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  is_valid      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
);
```

Billing table is intentionally excluded from V1. Add only when Stripe integration begins.

---

## Supported Providers

```typescript
type Provider =
  | 'anthropic'    // claude-sonnet-4-6, claude-opus-4-7
  | 'openai'       // gpt-4o, gpt-5-4, gpt-5-5
  | 'deepseek'     // deepseek-v4-pro, deepseek-v4-flash
  | 'google'       // gemini-pro, gemini-flash
  | 'mistral'      // mistral-large, codestral
  | 'openrouter'   // any model via openrouter.ai
  | 'groq'         // fast inference models
  | 'together'     // together.ai models
```

New providers = new adapter class. Zero changes to pipeline.

---

## API Routes Structure

```
POST  /api/auth/webhook              # Clerk webhook → create user in DB
GET   /api/credentials               # List user's connected providers
POST  /api/credentials               # Add and validate new API key
DELETE /api/credentials/:id          # Remove API key

GET   /api/projects                  # List projects (from local FS)
POST  /api/projects                  # Create new project
GET   /api/projects/:id              # Get project + memory

POST  /api/pipeline/start            # Start pipeline session
POST  /api/pipeline/message          # Send user message
GET   /api/pipeline/stream           # SSE stream of pipeline activity
POST  /api/pipeline/interrupt        # Human override injection
POST  /api/pipeline/resolve          # Human resolves conflict
POST  /api/pipeline/pause            # Pause pipeline
POST  /api/pipeline/play             # Resume pipeline
POST  /api/pipeline/stop             # Stop pipeline

GET   /api/output/:sessionId         # Get consensus code
GET   /api/budget                    # Current budget status
```

---

## Environment Variables Required

```bash
# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
CLERK_WEBHOOK_SECRET=

# Neon
DATABASE_URL=

# Upstash Redis
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Encryption (generate with: openssl rand -hex 32)
ENCRYPTION_KEY=

# Sentry
NEXT_PUBLIC_SENTRY_DSN=
SENTRY_AUTH_TOKEN=

# App
NEXT_PUBLIC_APP_URL=
```

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

## Pricing Reference (May 2026, for budget governor)

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
- Console.log only in development, never production
```

---

## When In Doubt

The architecture document is in `docs/architecture.md`.
The full decision log with reasoning is in the project PDF.
The pipeline is the product. The models are pluggable.
When adding any feature ask: does this serve the pipeline or distract from it?