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

Crucible is a model-agnostic multi-LLM coding orchestration platform. It solves the
core problem of single-model coding: one model cannot reliably catch its own mistakes
because it has systematic blind spots baked in from training. No amount of prompting
fixes a blind spot — you need a second model from a different training distribution.

Crucible routes every coding session through two models from completely different
AI families. A primary coder generates all code. A reviewer from a different company
cross-validates every output before it reaches the user. Code only enters the output
layer when both models reach consensus. The user brings their own API keys. Crucible
is the pipeline intelligence. The models are pluggable.

This is not an autocomplete tool. It is not a chat wrapper. It is a full pre-generation
planning system combined with a cross-model validation loop designed to produce
production-quality code from complex specifications without the user having to debug
generated output themselves.

---

## The Core Problem Being Solved

Single-model coding tools have four compounding problems that get worse as projects grow:

**Token exhaustion:** Claude Pro throttles invisibly after heavy sessions with no
warning and no visibility into how many tokens remain. The wall just appears.
The user has no graceful fallback and no way to plan around it.

**Single model blind spots:** Every model has systematic gaps from training that
manifest as consistent categories of missed bugs. The model that generated the
code uses the same reasoning to evaluate it, so it reliably misses the same things.
Cross-model review from a different training family catches a genuinely different
class of problems.

**No cross-validation:** Human code review works because multiple engineers with
different backgrounds catch different problems. Single-model coding has no equivalent.
There is no external check on the model's own output.

**Wrong requirements built correctly:** Most bugs are not code logic errors. They are
misunderstood requirements. A function that perfectly implements the wrong spec is
worse than a function with a logic error, because it passes superficial review. Crucible
attacks this with a pre-generation alignment phase that forces full requirement clarity
before any code is written.

---

## The Full Pipeline — Three Phases

No code is written until Phase 2 is complete. This is non-negotiable.
The pre-generation phases are what makes Crucible fundamentally different from
every other AI coding tool.

```
PHASE 0  →  PHASE 1  →  PHASE 1.5  →  PHASE 2  →  PHASE 3  →  OUTPUT
Context     Think        Align          Questions    Generate     Validated
(optional)  (silent)     (LLMs chat)    (user once)  (loop)       code
```

---

### PHASE 0 — Codebase Context (optional, fires before everything)

**Purpose:** Prevent generated code from being technically correct but stylistically
incompatible with the project it needs to integrate with.

**What it shows the user:**
```
"Is this a new project or adding to existing code?"

  ○ New project — I will establish patterns from scratch
  ○ Adding to existing code — I need context to match your patterns

If existing: (choose one or more)
  ○ Paste relevant interfaces, types, or key functions
  ○ Describe your existing patterns in plain English
    (e.g. "We use Prisma with PostgreSQL, Express middleware pattern,
    zod validation on all inputs, custom ApiError class for errors")
  ○ Upload key files (types.ts, middleware, base classes)
```

**What happens with the context:**
- Stored in the session as `codebaseContext`
- Injected as the FIRST block of context into both models before thinking begins
- Referenced in every prompt throughout Phases 1, 1.5, 2, and 3
- Stored in `memory.json` active layer for the full session

**Why this matters:**
Without this, a model asked to "add authentication" to an Express app using Prisma
might generate Mongoose schemas, use a different error handling pattern, and create
files in the wrong directory structure. The code works in isolation but breaks
integration. This phase makes that impossible.

---

### PHASE 1 — Silent Thinking (zero user interaction, both models run in parallel)

**Purpose:** Both models independently analyze the full prompt and codebase context
to capture requirements, identify ambiguities, and find edge cases. Neither model
speaks to the user. Neither model speaks to each other. They save everything internally.
The user sees a progress indicator: "Analyzing your requirements..."

**DeepSeek's thinking prompt (exact template):**
```
You are analyzing a coding requirement to prepare for implementation.
Do NOT generate any code yet.
Do NOT ask any questions yet.
Think completely and save everything for later.

Codebase context: {codebaseContext}
User requirement: {userPrompt}

Produce a structured analysis:
1. UNDERSTOOD_AS: What architecture/approach did you assume?
2. REQUIREMENTS: Every functional requirement you identified
3. AMBIGUITIES: Every point where multiple valid interpretations exist
4. OPEN_QUESTIONS: Every question you would need answered before coding
   For each question specify: what the question is, what options exist,
   and what you would recommend and why
5. ASSUMPTIONS: Every value or decision you would make without asking
   (these will all be surfaced to the user — do not silently decide)
6. TECHNICAL_CONSTRAINTS: Any implementation constraints you identified

Output as structured JSON. Do not write prose.
```

**Claude's thinking prompt (exact template):**
```
You are analyzing a coding requirement to find edge cases and gaps.
Do NOT generate any code yet.
Do NOT ask any questions yet.
Think completely and save everything for later.

Codebase context: {codebaseContext}
User requirement: {userPrompt}

Produce a structured analysis:
1. UNDERSTOOD_AS: What architecture/approach did you assume?
2. EDGE_CASES: Every boundary condition, empty state, error state,
   concurrent access scenario, and unusual input you can identify
3. MISSING_INFORMATION: Every piece of information absent from the prompt
   that would affect how the code should behave
4. SECURITY_CONSIDERATIONS: Auth, input validation, injection risks,
   rate limiting, data exposure risks
5. OPEN_QUESTIONS: Every question you would need answered
   For each: question text, options, recommended option, reason for recommendation
6. TECHNICAL_TENSIONS: Any pairs of requirements that might conflict

Output as structured JSON. Do not write prose.
```

**Both models run in parallel** using Promise.all for efficiency. The thinking
phase has a 60-second timeout per model. If a model exceeds 60 seconds,
its partial output is used and the pipeline continues.

---

### PHASE 1.5 — LLM Alignment Chat (zero user interaction, max 2 rounds)

**Purpose:** Models share what they each found before questions are compiled.
This is the single most important step for preventing bad specs. Without this,
DeepSeek might assume stateless JWT while Claude assumes stateful sessions.
They generate incompatible questions. The user answers both. The spec contains
a technical impossibility. This phase catches that before the user sees anything.

**Round 1 — Share and compare:**

DeepSeek message format:
```
ALIGNMENT_SHARE from DeepSeek:
I understood the requirement as: {understood_as}
I assumed the following architecture: {architecture_assumption}
My open questions are: {questions_list}
My unstated assumptions are: {assumptions_list}
```

Claude message format:
```
ALIGNMENT_SHARE from Claude:
I understood the requirement as: {understood_as}
I assumed the following architecture: {architecture_assumption}
My edge cases are: {edge_cases_list}
My open questions are: {questions_list}
I notice this potential tension with DeepSeek's understanding: {tension}
```

**Round 2 — Reconcile and agree on recommendations:**

The orchestrator detects architectural mismatches from Round 1 and prompts reconciliation:
```
ALIGNMENT_RECONCILE:
DeepSeek assumed: {deepseek_architecture}
Claude assumed: {claude_architecture}
These differ. You have one round to:
1. Agree on which architecture is correct given the prompt
2. OR agree that this is ambiguous and must be asked to the user
3. Agree on recommended options for every ambiguous question
4. Reframe any technically impossible question combinations
   into a single properly-informed choice question

If you cannot agree in this round, the disagreement becomes
the first question shown to the user.
```

**Hard stop rules:**
- Maximum 2 rounds. No exceptions. No "just one more round."
- After 2 rounds any unresolved disagreement surfaces as a user question
- The alignment chat is stored in `session_log.jsonl` for audit but never shown to the user by default
- Total token budget for alignment chat: 3,000 tokens maximum
  If either model is approaching the limit, truncate and move to compilation

**What this fixes:**
- Gap 1: Architectural assumption mismatches caught and resolved
- Gap 4: Models agree on recommended options with reasoning before user sees them
- Gap 5: Technically impossible combinations identified and reframed into one informed question
- Semantic deduplication: models understand each other's intent so identical questions
  with different wording are recognized as duplicates

---

### PHASE 2 — Questions and Alignment (the only required user interaction before coding)

**STEP 1 — Question compilation:**

Collect all questions from both models' thinking outputs plus any unresolved
items from the alignment chat. Apply semantic deduplication: two questions
are the same if they are asking for the same user decision, regardless of
how they are worded. "How long should tokens last?" and "What is the JWT
expiry duration?" are the same question.

Run a second-pass check: given all the questions and their options together,
do any new edge cases emerge from combinations? For example, if one question
asks about refresh tokens and another asks about concurrent sessions, a
combination edge case might be: what happens if a refresh token is used from
a new device while the original session is still active? Add this as a question.

Group questions by category:
```
Core Behavior    — what the feature does in normal operation
Security         — auth, permissions, rate limiting, data protection
Error Handling   — what happens when things go wrong
Edge Cases       — boundary conditions, empty states, unusual inputs
Integration      — how this connects to the rest of the system
```

**STEP 2 — Single dialogue screen:**

All questions shown at once in their groups. Never interrupted. The user
answers everything in one sitting. The screen shows:

```
┌────────────────────────────────────────────────────────────┐
│ CRUCIBLE                                                   │
│ I analyzed your requirements completely.                   │
│ Answer these once and I will handle everything else.       │
│                                                            │
│ Feature: JWT Authentication Module                         │
│ Questions: 14    Estimated time: ~3 minutes                │
│ ████████████░░░░░░░░  Progress: 6 of 14                    │
│                                                            │
│ ── CORE BEHAVIOR ─────────────────────────────────────     │
│                                                            │
│ 1. How long should login sessions last?                    │
│    ○ 1 hour (high security environments)                   │
│    ○ 24 hours  ← recommended for most web applications     │
│    ○ 7 days                                                │
│    ○ 30 days                                               │
│    ○ Custom: [          ]                                  │
│                                                            │
│ 2. Should refresh tokens be supported?                     │
│    ○ Yes — sessions auto-renew silently                    │
│    ○ No — user must log in again after expiry              │
│           ← recommended if simplicity is priority          │
│                                                            │
│ ── SECURITY ───────────────────────────────────────────    │
│ ...                                                        │
│                                                            │
│ [Build It →]                                               │
└────────────────────────────────────────────────────────────┘
```

**Question display rules:**
- No cap on question count — every surfaced decision gets asked
- No defaults assumed silently — if it was not explicitly answered it gets asked
- Every question must have options where possible (multiple choice over free text)
- Every recommended option must include a plain English reason explaining why
  it is recommended. A tick or star with no explanation is not acceptable.
- Questions within a group are ordered by impact: architectural decisions first,
  implementation details last
- Show question count and estimated time at the top
- Show progress indicator as user answers
- Free text input available on every question for custom answers

**STEP 3 — Second-pass questions (appended to same screen):**

After user submits initial answers, the orchestrator runs one silent pass:
given these answers together, do any new edge cases emerge that could not
have been generated from the prompt alone?

Example: If user answered YES to refresh tokens AND YES to concurrent sessions,
a new edge case emerges: what happens if a refresh token is used from a new
device while the original session is still active? This question is appended
to the bottom of the same screen under a "Based on your answers above:" header.

User answers these additional questions before clicking Build It.
This second pass runs once only. No further passes.

**STEP 4 — Contradiction check (runs before spec is locked):**

When user clicks Build It, before writing any spec, the system runs a
contradiction check against all answers. This is a deterministic check, not
a model call. It uses a pre-built list of known incompatible answer combinations.

Known incompatibilities to check:
```
stateless_jwt: true  +  server_side_invalidation: true
  → "Stateless JWT cannot support server-side invalidation
     without a token blacklist, making it stateful.
     Choose: pure stateless (tokens expire naturally, no force logout)
     or stateful blacklist (force logout supported, adds Redis dependency)"

session_expiry: 1_hour  +  refresh_tokens: false  +  user_type: general_public
  → "1 hour sessions without refresh tokens may frustrate general users
     who get logged out mid-task. Consider either longer sessions or
     enabling refresh tokens."
```

When contradiction found, it is flagged inline on the same screen. User
resolves it before spec is locked. Spec is never written with known contradictions.

**STEP 5 — Answer expansion (zero user interaction, runs automatically):**

The orchestrator takes all user answers and automatically generates four artifacts:

Spec document (spec.json):
```json
{
  "feature": "JWT Authentication Module",
  "what_it_does": [...],
  "acceptance_criteria": [...],
  "edge_cases": [...],
  "explicit_out_of_scope": [...],
  "user_decisions": { "session_expiry": "24h", "refresh_tokens": false, ... },
  "model_defaults": {
    "bcrypt_rounds": 12,
    "note": "Not asked — industry standard. User can override."
  },
  "agreed_by": {
    "primary": "deepseek-v4-pro",
    "reviewer": "claude-sonnet-4-6",
    "human_confirmed": false
  }
}
```

Edge cases list (appended to spec.json under edge_cases):
Generated automatically from user answers. Example: user answered
"lock after 5 failed attempts" → edge cases auto-generated:
- "What if account is locked and user tries to reset password?"
- "What if lock expires exactly when user submits 6th attempt?"
- "What if admin unlocks account mid-lockout window?"

Test cases list (appended to spec.json under test_cases):
One test case per acceptance criterion, one per edge case.
Format: { input, expected_output, spec_reference }

Error messages (appended to spec.json under error_messages):
One per failure scenario identified. User-facing message, HTTP status,
internal log message, all three specified for every error scenario.

MODEL DEFAULT items are flagged with a "model_defaults" key in spec.json
and shown on the confirmation screen as decisions the user did not make
but that the model will use. User can change these before confirming.

**STEP 6 — Spec confirmation screen:**

The last human checkpoint before any code is written.

```
┌────────────────────────────────────────────────────────────┐
│ HERE IS WHAT I AM BUILDING                                 │
│                                                            │
│ Feature: JWT Authentication Module                         │
│                                                            │
│ What it does:                                              │
│ • Login with email/password → returns JWT (24h expiry)     │
│ • Logout invalidates token server-side via Redis blacklist │
│ • Account locks after 5 failed attempts (auto 30min)       │
│ • Refresh tokens: not included in this build               │
│                                                            │
│ Edge cases handled:                                        │
│ • Empty email → 400 Bad Request                           │
│ • Wrong credentials → 401 Unauthorized                    │
│ • Locked account → 403 Forbidden with unlock time         │
│ • Expired token → 401 with re-login message               │
│ • Concurrent login → both sessions valid                  │
│                                                            │
│ Out of scope (will not be built):                          │
│ • OAuth / social login                                     │
│ • Two-factor authentication                                │
│ • Password reset flow                                      │
│                                                            │
│ Your decisions:                                            │
│ • Session expiry: 24 hours                                 │
│ • Lockout: 5 attempts, auto-unlock after 30 minutes        │
│ • Concurrent sessions: allowed                             │
│                                                            │
│ Model defaults (you did not specify these — review them):  │
│ ⚠ bcrypt rounds: 12  (industry standard)                  │
│ ⚠ token algorithm: HS256  (symmetric, standard for APIs)  │
│                                                            │
│ [Start Building]    [Edit This]    [Start Over]            │
└────────────────────────────────────────────────────────────┘
```

When user clicks Start Building:
- spec.json is written to the project folder
- spec.json is NEVER overwritten after this point
- If user wants to change the spec, they must click Edit This and go back through Phase 2
- human_confirmed is set to true in spec.json
- Phase 3 begins

---

### PHASE 3 — Generation Loop (zero user interaction unless hard conflict or human override)

**DeepSeek generates code against the confirmed spec:**

Primary generation prompt includes:
```
You are generating production-quality code.
You have a confirmed spec that is your contract.
Do not deviate from the spec. Do not add features not in the spec.
Do not make architectural decisions not in the spec.

Codebase context: {codebaseContext}
Confirmed spec: {spec}
Current module focus: {currentModule}
Previously built: {completedModuleInterfaces}
Session history (last 40k tokens): {sessionHistory}

Generate the complete implementation.
Match the coding patterns from the codebase context exactly.
Use the same error handling pattern, naming conventions,
file structure, and dependency choices as the existing codebase.
```

**DeepSeek self-check (agent layer, runs before sending to Claude):**

After generation, before review, DeepSeek runs its own verification pass.
This catches syntax errors and missing spec items before wasting Claude's
review budget on things DeepSeek can catch itself.

Self-check prompt:
```
Review the code you just generated.
Check BOTH presence AND correctness for every spec item.

For each acceptance criterion in the spec:
1. Does handling code exist? (presence check)
2. Does the code produce the EXACT output specified in the spec?
   Check status codes precisely (400 not 200, 401 not 403)
   Check return value shapes precisely
   Check error message text precisely
   Check all edge cases in the spec's edge_cases list

Report any spec item where:
- No handling code exists
- The code exists but produces wrong output

Fix any issues you find. Maximum 2 self-correction passes.
After 2 passes submit regardless of remaining issues.
Claude will catch what you cannot.

Output format:
{
  "items_checked": number,
  "issues_found": [...],
  "issues_fixed": [...],
  "remaining_issues": [...],
  "ready_for_review": boolean
}
```

Hard limit: 2 self-correction passes. If issues remain after 2 passes, they
are passed to Claude's review. DeepSeek's self-check is scoped to:
- Syntax and compilation errors
- Spec item presence
- Output correctness (status codes, return shapes, error messages)

DeepSeek's self-check is NOT scoped to:
- Logic errors and edge case coverage (same blind spots as generation)
- Security vulnerabilities (needs different perspective)
- Architecture correctness (needs full system view)

**Claude reviews code against spec:**

Review prompt template:
```
You are reviewing generated code against a confirmed spec.
The spec is your contract. Review against the spec, not against
general best practices (unless they are in the spec).

Confirmed spec: {spec}
Code to review: {generatedCode}
Round number: {roundNumber}
Previous review (if round > 1): {previousReview}

REVIEW DIMENSIONS (check all):
1. Logic correctness: does each function produce correct output?
2. Spec coverage: is every acceptance criterion met?
3. Edge case handling: is every spec edge case handled correctly?
4. If round > 1: re-verify ALL functions sharing dependencies
   with the changed code, not only the changed function.
   List every function you re-checked in dependencies_rechecked.
   This prevents regressions from fixes breaking other functions.

CONFIDENCE SCORING for every flag:
HIGH: I am certain this is a bug. I can prove it from the code.
MEDIUM: I am highly confident. The code appears wrong but I cannot
        prove it without runtime context.
LOW: I suspect an issue but cannot confirm from static analysis.
     Common for: timing attacks, race conditions, security side-channels.

ROUTING:
HIGH + MEDIUM flags → send as pseudo-code hints to primary
LOW flags → do NOT send to primary, add to review_list only

CRITICAL: Never write full code. Only pseudo-code hints.
WRONG: "Change line 47 to: if (!email || email.trim() === '') {"
RIGHT: "Line 47: empty string check missing — suggest: also check
        email.trim() is not empty, not just that email is truthy"

Output format:
{
  "consensus": boolean,
  "round": number,
  "critical_bugs": [...],
  "logic_errors": [...],
  "edge_cases_missed": [...],
  "pseudo_code_hints": [...],
  "low_confidence_flags": [...],
  "dependencies_rechecked": [...],
  "reasoning": string
}
```

**Consensus and conflict routing:**

```
consensus: true
  → code is promoted to output layer
  → low_confidence_flags appended to review_list.json
  → session_log.jsonl updated
  → checkpoint triggered if module complete

consensus: false, round < 3
  → pseudo_code_hints sent to DeepSeek
  → DeepSeek fixes and regenerates
  → Claude reviews again
  → Round counter incremented

consensus: false, round === 3
  → IMMEDIATE human escalation
  → Escalation message format:
    "Generation loop could not reach consensus after 3 rounds.
     Specific technical conflict: [exact technical reason extracted
     from the last review, not just 'models disagree']
     Primary's position: [one line]
     Reviewer's position: [one line]
     Your decision: [specific question with options]"
  → Pipeline pauses waiting for human input
  → Human answer injected as HUMAN OVERRIDE
  → Loop resets to round 1 with human decision as context
```

**Human controls (active throughout Phase 3):**

Any typed message in the conversation layer is treated as a human override:
```
Inject to both models:
"HUMAN OVERRIDE: {message}
 All prior reasoning is subordinate to this instruction.
 Acknowledge this override explicitly before continuing.
 Do not resume prior reasoning thread without acknowledging."

Both models must output the word "ACKNOWLEDGED:" followed by
a one-line summary of the override before any other output.
This prevents the failure mode where a model says "noted, however..."
and then proceeds with its original reasoning anyway.
```

Direct prompt editing: if the user edits any model's prompt mid-session:
1. Discard that model's previous response (it was based on wrong prompt)
2. Log the edit to session_log.jsonl with timestamp and both old and new prompt
3. Re-run that model with the edited prompt
4. Continue pipeline from that point
5. The session trace remains accurate because the edit is logged

Pause behavior:
1. Freeze pipeline — no new model calls
2. Save full pipeline state to Redis with 24-hour TTL
3. On Play: before resuming, check for any human commands inserted during pause
4. If commands found: inject as HUMAN OVERRIDE before any model call
5. Resume from frozen state

Stop behavior:
1. Kill all active model calls immediately
2. Write current state to session_log.jsonl
3. Update memory.json with current active memory
4. Save checkpoint with "user_stopped" trigger
5. Pipeline terminates cleanly

---

### OUTPUT LAYER

Only consensus-validated code reaches this layer. Nothing else.

What the output layer shows:
```
OUTPUT LAYER
├── The generated code files (written to output/ directory)
├── Clean diff from previous version of same module
├── Change log:
│     Round 1: generated auth module
│     Round 2: fixed empty string validation on email
│     Round 3: consensus reached
│     Human decisions: none in this session
├── Review list (low-confidence flags):
│     ⚠ Possible timing attack in password comparison
│       (cannot confirm statically — manual review recommended)
│     ⚠ Concurrent token refresh may have race condition
│       (verify with load testing)
└── Full conversation trace available on demand
    (all three phases, alignment chat, all review rounds)
```

The review list is cumulative across sessions. Items are added as they are
flagged and removed only when the user explicitly marks them resolved.
Never automatically cleared.

---

### CONVERSATION TAB

The conversation tab is always one click away from the main screen.
It is the primary tool for the user to understand what happened,
spot hallucinations, and audit every decision the pipeline made.

Every pipeline event is listed as a timestamped timeline entry.
Entries are collapsed by default. Every entry is expandable.
The user never has to hunt for what happened — it is all here in order.

**What the conversation tab looks like:**

```
CONVERSATION TAB                              [Download full trace ↓]

14:23:01  ✓  Phase 1 — Silent thinking
             DeepSeek and Claude analyzed your requirements in parallel
             Duration: 8 seconds  [Expand to see full thinking output ▾]

14:23:09  ⚠  Phase 1.5 — Alignment chat  (1 conflict found)
             DeepSeek assumed: stateless JWT
             Claude assumed: stateful sessions with Redis
             → Conflict added to question 1 for your decision
             Duration: 11 seconds  [Expand to see full alignment chat ▾]

14:24:00  ◎  Phase 2 — Dialogue (14 questions)
             User answered all questions in 3 min 12 sec
             [View your answers ▾]

14:27:12  ✓  Spec confirmed by user
             12 acceptance criteria · 8 edge cases · 20 test cases
             2 model defaults accepted (bcrypt rounds, token algorithm)
             [View full spec ▾]

14:27:18  →  Round 1 — DeepSeek generating auth_login...
             Tokens: 8,420 in / 1,840 out  Cost: $0.0052
             Self-check: 1 issue found and fixed (missing null check)
             [Expand ▾]

14:27:28  ✗  Round 1 — Claude reviewing...
             Consensus: NO
             HIGH: empty string not caught on email field
             LOW: possible timing attack → added to review list
             Sending pseudo-code hints to DeepSeek
             [Expand to see full review ▾]

14:27:45  →  Round 2 — DeepSeek fixing...
             Applied: email empty string check added
             Tokens: 6,210 in / 920 out  Cost: $0.0036
             [Expand ▾]

14:27:55  ✓  Round 2 — Claude reviewing...
             Consensus: YES
             Re-checked: validateToken, refreshToken (shared dependency)
             [Expand ▾]

14:27:59  ✓  Code promoted to output layer
             auth_login module complete
             1 item added to review list
             Checkpoint saved

─────────────────────────────────────────────────────────────────────
                    Total cost this session: $0.31
─────────────────────────────────────────────────────────────────────
```

**Visual indicators for every entry:**
```
✓  green   — completed successfully, consensus reached, phase done
✗  red     — consensus not reached, conflict escalated, issue found
⚠  amber   — warning, conflict detected, human action needed
◎  blue    — user interaction (dialogue answered, spec confirmed)
→  gray    — in progress, model currently working
```

**What expands when user clicks an entry:**

Phase 1 expand:
```
DEEPSEEK THINKING OUTPUT:
Understood as: stateless JWT with RS256 signing
Requirements identified: [list]
Ambiguities found: [list]
Questions prepared: [list]
Assumptions: [list]

CLAUDE THINKING OUTPUT:
Understood as: stateful session with Redis blacklist
Edge cases found: [list]
Missing information: [list]
Security considerations: [list]
Questions prepared: [list]
```

Generation round expand:
```
DEEPSEEK GENERATION (Round 2):
Prompt context: [token count] tokens
Output: [token count] tokens
Self-check result: passed (no issues)
Code generated: [shows the actual code]

CLAUDE REVIEW (Round 2):
Input: [token count] tokens
Review output: [shows the full structured JSON review]
Consensus: true
Dependencies re-checked: validateToken, refreshToken
Low confidence flags: 1 (added to review list)
```

Human override entry (highlighted amber):
```
⚠ HUMAN OVERRIDE at 14:31:22
   User typed: "wrong thought change to this"
   Injected to both models as priority context
   Both models acknowledged before continuing
   [See full override context ▾]
```

**Human can intervene from the conversation tab:**

At any expanded entry, the user can:
- Edit the model's prompt that was used (triggers re-run from that point)
- Type a correction into the entry's reply box (injected as HUMAN OVERRIDE)
- Mark an alignment conflict as resolved (with their own decision)
- Mark a review flag as accepted or dismissed

**What is never shown in the conversation tab automatically:**

- Raw API payloads (available in full trace download only)
- Token-level details (shown only in expanded entry, not in summary)
- Other users' sessions (each user sees only their own projects)

**Conversation tab is the hallucination detector:**

The primary use case for this tab is the user scrolling through a session
and noticing when a model said something wrong. For example:
- DeepSeek assumed the wrong architecture in Phase 1 → visible immediately
- Claude flagged something that was actually correct → user can dismiss it
- A model's self-check passed something it should not have → auditable
- An alignment conflict was resolved incorrectly → user can re-resolve

Without this tab the user has no way to understand what happened inside
the pipeline. With it they have complete transparency without being overwhelmed
because every entry starts collapsed and the user digs in only when needed.

---

## Critical Architectural Rules (12 Rules — None Negotiable)

### Rule 1 — Reviewer Returns Pseudo-Code Only. Never Full Code.
```
The reviewer's only job is to identify what is wrong and give a hint
toward the fix. It is not the reviewer's job to fix the code.

WRONG: Reviewer writes "Change the function to:
        async function validateToken(token) {
          if (!token) throw new ApiError(401, 'No token')
          ..."
RIGHT: "validateToken has no null check — suggest: add early return
        if token is falsy before calling jwt.verify"

Why this matters: if reviewer writes full code it becomes a second
primary model. Claude's $5 budget at $0.0075 per review pass covers
~666 passes. If Claude returns 2000-token code responses instead of
100-token hints, budget exhausts in ~33 passes. The pseudo-code
constraint is a budget protection rule as much as an architectural one.
```

### Rule 2 — Human Override Is Injected with Explicit Acknowledgment Required
```
Every human message in Phase 3 is injected as:

"HUMAN OVERRIDE: {message}
 All prior reasoning is subordinate to this instruction.
 Acknowledge this override explicitly before continuing.
 Do not resume prior reasoning without acknowledgment."

Both models MUST output "ACKNOWLEDGED: [one-line summary of override]"
as their first output before anything else.

This prevents the failure mode where a model outputs "Understood,
however based on our earlier analysis..." and then continues on its
original track. Explicit acknowledgment blocks that pattern.
```

### Rule 3 — Hard Conflict Escalation Must Include Technical Reason
```
When escalating to human after 3 generation rounds:

WRONG: "Models could not reach consensus."
RIGHT: "The spec requires stateless JWT [from spec line 4] but also
        requires real-time device logout [from spec line 12].
        These cannot coexist: stateless JWT has no server-side token
        registry, so logout cannot invalidate tokens on other devices.
        Choose: pure stateless (tokens expire naturally, no cross-device
        logout) or add a Redis token blacklist (stateful, cross-device
        logout supported, ~2ms overhead per request)"

The human needs the technical reason to make a real decision.
Without it they cannot choose meaningfully.
```

### Rule 4 — Output Layer Only Receives Consensus Code
```
The output layer is the only thing the user ships from.
It must be treated as sacred.

Nothing is written to output/ without consensus: true
from the reviewer's structured JSON response.

Intermediate versions, draft code, partially fixed code —
none of it goes to output/. They stay in session_log.jsonl
for audit but never reach output/.
```

### Rule 5 — API Keys Are Encrypted at Rest and Never Logged
```
Encryption: AES-256-GCM
Key source: ENCRYPTION_KEY environment variable (never hardcoded)
Storage: encrypted_key column in api_credentials table
Decryption: only at the moment of API call, in server memory only
Logging: API keys are NEVER written to any log, console, or file
Frontend: API keys are NEVER sent to the client in any response
Validation: test the key works before storing it (one real API call)
```

### Rule 6 — Think First, Ask Once, Never Ask Again
```
Models complete their FULL thinking pass before any question is generated.
All questions from both models are compiled into one single dialogue.
User answers everything in one sitting.
After the user clicks Build It those answers are permanent for this session.
They are stored in spec.json and injected as context in every Phase 3 prompt.

Never ask about a topic the user already answered.
Never re-ask a question even if the pipeline encounters the topic again.
If the spec needs changing: user must explicitly trigger spec revision.
```

### Rule 7 — No Defaults Assumed Silently. Every Decision Is Surfaced.
```
When a model would make an assumption (e.g. bcrypt rounds = 12),
it must save that assumption as a MODEL DEFAULT, not silently use it.

MODEL DEFAULT items are shown on the spec confirmation screen.
User can accept them with one click or change them before confirming.

The only values allowed to be assumed without asking:
- True industry standards with no reasonable alternative
  (e.g. HTTPS only, bcrypt for passwords, parameterized SQL queries)
- Values that can be trivially changed after generation with no
  architectural impact (e.g. default page size = 20)

Everything else gets asked.
```

### Rule 8 — Recommended Options Must Include Plain English Reasoning
```
Every recommended option in the question dialogue must explain why.

WRONG: "○ 5 attempts  ★ recommended"
WRONG: "○ 5 attempts  ← recommended"
RIGHT: "○ 5 attempts  ← recommended for most web applications.
        Lower values frustrate legitimate users who mistype passwords.
        Higher values reduce security. 5 is the industry balance point."

The recommendation reasoning must be specific to the context, not generic.
If the codebase context indicates a financial application, the recommendation
and reasoning should reflect that (e.g. recommend 3 attempts, not 5).
```

### Rule 9 — Self-Check Verifies Correctness Not Just Presence
```
DeepSeek's self-check must check that each spec item produces the
CORRECT output, not just that some code exists for it.

The self-check prompt explicitly says:
"Check status codes precisely (400 not 200, 401 not 403)"
"Check return value shapes precisely"
"Check error message text precisely"

A function that returns status 200 for an error condition passes a
presence check but fails a correctness check. The self-check must
catch this. The self-check prompt enforces this explicitly.

Hard limit: 2 self-correction passes. Never exceed this.
Purpose: catch syntax errors and obvious spec violations early.
Scope: syntax + spec coverage + output correctness only.
Not in scope: logic errors, edge cases, security (same blind spots).
```

### Rule 10 — Claude Re-Checks Shared Dependencies Every Round After Round 1
```
In rounds 2 and 3, Claude's review prompt explicitly requires:
"Re-verify ALL functions that share dependencies with any changed code.
List every function you re-checked in the dependencies_rechecked field."

Why: DeepSeek fixes a bug in function A which touches the token storage
layer. Function B also uses the token storage layer. Claude's round 2
review checks function A's fix but not function B. Function B is now
broken. The code reaches consensus with a regression.

The explicit re-check requirement + the listing requirement prevents this.
Claude cannot skip it silently because it must list what it checked.
```

### Rule 11 — Low Confidence Flags Go to Review List. Never Dropped.
```
LOW confidence flag routing:

WRONG: discard them (they are unproven, why show them?)
RIGHT: add them to review_list.json with:
  - the flag description
  - why it is low confidence
  - what testing would confirm or deny it
  - which function/line it relates to

The review list is shown in the output layer under "Flagged for manual review."
User decides what to do with each item.

Why this matters: security vulnerabilities like timing attacks and
race conditions are by definition hard to prove from static code review.
They are exactly the low-confidence category. Dropping them means
shipping with known potential security risks because they were "unproven."
```

### Rule 12 — LLM Alignment Chat Hard Stop at 2 Rounds
```
Maximum 2 rounds. No exceptions.
Token budget for alignment chat: 3,000 tokens total.

If models have not aligned after 2 rounds:
- Any unresolved architectural disagreement → becomes first user question
- Any unresolved recommendation disagreement → both options shown to user
  without a recommendation (user decides without model influence)
- Pipeline continues to question compilation

Models cannot negotiate architecture with each other indefinitely.
If they cannot agree in 2 rounds, the user is the tiebreaker.
```

---

## Model Architecture

### The Adapter Pattern

Every model implements the same interface. The pipeline never knows or cares
which company made the model. Adding a new provider requires writing one new
adapter class. Zero changes to the pipeline, the phases, or the routing logic.

```typescript
interface ModelAdapter {
  // Phase 1: silent thinking
  think(prompt: string, context: ThinkingContext): Promise<ThinkingOutput>

  // Phase 1.5: alignment chat
  chat(message: string, context: AlignmentContext): Promise<AlignmentMessage>

  // Phase 3: code generation (streaming)
  generate(prompt: string, context: GenerationContext): AsyncGenerator<string>

  // Phase 3: self-check (primary only)
  selfCheck(code: string, spec: SpecDocument): Promise<SelfCheckOutput>

  // Phase 3: code review (reviewer only)
  review(code: string, spec: SpecDocument, round: number): Promise<ReviewPayload>

  // Utilities
  getProvider(): Provider
  getModelId(): string
  estimateCost(inputTokens: number, outputTokens: number): number
}

interface ThinkingOutput {
  understood_as: string
  requirements: string[]
  ambiguities: string[]
  open_questions: Question[]
  assumptions: Assumption[]
  technical_constraints: string[]
}

interface AlignmentMessage {
  model: string
  understood_as: string
  architecture_assumption: string
  open_questions: Question[]
  recommendations: RecommendedOption[]
  conflicts_with_other_model?: string
}

interface Question {
  id: string
  topic: string
  question: string
  options: QuestionOption[]
  affects: string[]
  source: 'primary' | 'reviewer' | 'both' | 'second_pass'
  priority: 'architectural' | 'behavioral' | 'implementation'
}

interface QuestionOption {
  value: string
  label: string
  is_recommended: boolean
  recommendation_reason: string   // required when is_recommended: true, never empty
}

interface Assumption {
  topic: string
  assumed_value: string
  reason: string                  // why this is an industry standard default
  can_be_overridden: boolean
}

interface SelfCheckOutput {
  items_checked: number
  passes: number
  issues_found: SelfCheckIssue[]
  issues_fixed: SelfCheckIssue[]
  remaining_issues: SelfCheckIssue[]
  ready_for_review: boolean
}

interface SelfCheckIssue {
  spec_item: string
  type: 'missing' | 'wrong_output' | 'wrong_status_code' | 'wrong_shape'
  description: string
  line_reference?: string
}

interface ReviewPayload {
  consensus: boolean
  round: number
  critical_bugs: ReviewFlag[]
  logic_errors: ReviewFlag[]
  edge_cases_missed: ReviewFlag[]
  pseudo_code_hints: string[]        // HIGH + MEDIUM only, pseudo-code only
  low_confidence_flags: ReviewFlag[] // goes to review list, never dropped
  dependencies_rechecked: string[]   // list of functions re-checked this round
  reasoning: string
}

interface ReviewFlag {
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  description: string
  location: string                   // function name or line reference
  spec_reference?: string            // which spec item this relates to
}
```

### Implemented Adapters
```typescript
// src/lib/adapters/
DeepSeekAdapter    — deepseek-v4-pro, deepseek-v4-flash
ClaudeAdapter      — claude-sonnet-4-6, claude-opus-4-7
OpenAIAdapter      — gpt-4o, gpt-5-4, gpt-5-5
GoogleAdapter      — gemini-pro, gemini-flash
MistralAdapter     — mistral-large, codestral
OpenRouterAdapter  — any model via openrouter.ai
GroqAdapter        — fast inference models
TogetherAdapter    — together.ai models
```

### Recommended Default Configuration
```
PRIMARY (code generation):
  DeepSeek V4 Pro
  $0.435 input / $0.87 output per 1M tokens
  80.6% SWE-bench Verified
  Beats Claude Sonnet on raw coding benchmarks
  1M token context window
  Role: all code generation in Phase 3

REVIEWER (cross-validation):
  Claude Sonnet 4.6
  $3.00 input / $15.00 output per 1M tokens
  79.6% SWE-bench Verified
  Different training family = genuine cross-validation
  1M token context window
  Role: architecture, alignment chat, review, escalation

BUDGET SPLIT:
  $20 DeepSeek V4 Pro = 35.4 million tokens
  $5 Claude Sonnet 4.6 = 0.76 million tokens
  Total: 36.2 million tokens vs Claude Pro's 1-2M
  Value: 18-36x more usable tokens for same $25
```

### Why Not The Same Model Family for Both Roles
```
The entire value of cross-validation depends on genuinely different
training distributions. DeepSeek reviewing DeepSeek's code has the
same blind spots as DeepSeek generating it. The review provides no
new information — it just confirms what the generator already believed.

Different company = different training data = different systematic gaps.
When DeepSeek misses an edge case, Claude has a reasonable chance of
catching it because Claude was trained differently. This is the core
mechanism. Never assign reviewer and primary from the same model family.
```

---

## Memory System

### Two-Tier Memory Design

Memory is split into two tiers with different injection rules.
This is the primary cost optimization — active memory stays lean,
archive is only loaded when relevant.

```typescript
interface ProjectMemory {
  active: ActiveMemory    // always injected every session (~5-8k tokens max)
  archive: ArchiveMemory  // injected only when relevant
}

interface ActiveMemory {
  current_module: string              // what is being built right now
  open_questions: string[]            // unresolved questions from this session
  current_file_structure: FileTree    // current state of project files
  recent_decisions: Decision[]        // decisions made in last 3 sessions
  current_tech_stack: string[]        // confirmed technologies in use
  unresolved_conflicts: Conflict[]    // conflicts not yet resolved
  model_defaults_accepted: Record<string, string>  // user-accepted defaults
}

interface ArchiveMemory {
  completed_modules: CompletedModule[]    // only interface/API surface kept
  resolved_decisions: Decision[]          // compressed to one-line summaries
  earlier_architecture: string[]          // high-level architecture decisions
  deprecated_approaches: string[]         // things tried and rejected
}

interface CompletedModule {
  name: string
  interface_only: string    // function signatures only, no implementation
  decision_summary: string  // one paragraph of key decisions made
}
```

### Session Resume
On every session start:
1. Load active memory → inject as context block 1
2. Load last 40,000 tokens of session_log.jsonl → inject as context block 2
3. Load spec.json if it exists → inject as context block 3
4. Both models are fully caught up

Note: 40,000 tokens not 50 messages. Token count preserves quality
regardless of message length. 50 short messages may be trivial context.
50 code-heavy messages may be 100k+ tokens. Always count tokens.

### Compression Rules (when active memory exceeds 8,000 tokens)
```
Move to archive:
├── Any decision older than 3 sessions → compress to one-line format:
│   "Decision: use JWT with RS256. Reason: needed public key validation
│    for microservice architecture"
│
├── Any completed module → compress to interface only:
│   Keep: function signatures, exported types, public API surface
│   Drop: implementation details, internal functions, comments
│
├── Any resolved conflict → compress to outcome only:
│   "Conflict: stateless vs stateful. Resolved: stateful with Redis
│    blacklist. Human decision in session 3."
│
└── Any code version superseded → drop entirely:
    Only the final version of any code block is retained
    Old versions exist in session_log.jsonl for audit but not in memory

NEVER compress:
├── Current module being built (full context always)
├── spec.json (always available as a separate inject)
├── Last 5 conversation exchanges (always full)
├── Human override decisions (permanent, never archived)
└── Unresolved conflicts (stay in active until resolved)
```

---

## Budget Governor

The budget governor exists to ensure $20 of DeepSeek + $5 of Claude
lasts a full month for realistic usage. Without it, a heavy session can
burn through budget in a day, leaving three weeks of nothing.

### Operating Modes

**FULL MODE (>75% monthly budget remaining)**
```
Normal pipeline operation
Full context loading
No prompt compression
No restrictions
UI indicator: green
```

**EFFICIENT MODE (50-75% remaining)**
```
Context compression kicks in:
- Archive memory loaded on-demand only (not every session)
- Reviewer prompt tightened to reduce output tokens
- Stop sequences added to all model calls to prevent unnecessary prose
- Session history reduced from 40k to 25k tokens
UI indicator: yellow — "Optimizing token usage"
```

**CONSERVATION MODE (25-50% remaining)**
```
Aggressive compression:
- Active memory trimmed to absolute essentials
- Only current module + last 3 exchanges in context
- Session summaries replace raw history
- DeepSeek self-check disabled (save tokens, rely on Claude)
- Claude used only for final output confirmation, not alignment chat
UI indicator: orange — "Running lean — [X]% budget remaining"
```

**CRITICAL MODE (<25% remaining)**
```
User explicitly warned with options:
  ○ Continue — DeepSeek only (Claude budget exhausted)
  ○ Top up — add $5 Claude API credits to continue full pipeline
  ○ Save and resume next month — checkpoint saved, session ends cleanly
DeepSeek takes over as both generator and reviewer temporarily
Quality reduced but not zero — pipeline does not hard-stop
UI indicator: red — "Claude budget low — your options: [...]"
```

### Budget Dashboard (always visible)
```
Monthly budget:     $25.00
Spent so far:       $8.40  (Claude: $1.20, DeepSeek: $7.20)
Remaining:          $16.60
Days elapsed:       14 of 30
Daily average:      $0.60
Projected month-end: $18.00  (under budget)
Current mode:       EFFICIENT

This session:
  Tokens used:      47,420
  Cost this session: $0.31
  Current module:   Auth — login function
  Est. completion:  ~$0.08 more
```

### Token Cost Reference (May 2026)
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
} // prices per 1 million tokens
```

---

## Local File Structure

All project data lives on the user's machine. Nothing is sent to Crucible's
servers except auth tokens and encrypted API keys.

```
~/.crucible/
└── projects/
    └── {project-id}/
        ├── memory.json
        │     active:  current state, always injected
        │     archive: completed work, injected on demand
        │
        ├── session_log.jsonl
        │     every message, every model, every human edit
        │     append-only — never deleted, never overwritten
        │     timestamped with ISO8601 per entry
        │
        ├── spec.json
        │     written once at Phase 2 completion
        │     NEVER overwritten — spec revision is a new flow
        │     contains: acceptance_criteria, edge_cases, test_cases,
        │               error_messages, user_decisions, model_defaults
        │
        ├── review_list.json
        │     low-confidence flags accumulate here across sessions
        │     items removed only when user explicitly marks resolved
        │     shown in output layer under "Flagged for manual review"
        │
        ├── config.json
        │     primary model, reviewer model, budget settings,
        │     project name, created date, last active date
        │
        ├── checkpoints/
        │     {ISO8601}_{trigger}.json
        │     trigger values: module_complete, conflict_resolved,
        │                     human_confirmed, manual_save, user_stopped
        │     each checkpoint: full output snapshot + one-paragraph summary
        │
        └── output/
              consensus-validated code files only
              organized in same structure as the actual project
```

### Checkpoint Behavior
```
Automatic checkpoint triggers:
1. module_complete — when consensus is reached and code is promoted to output
2. conflict_resolved — when human resolves a 3-round escalation
3. human_confirmed — when spec is confirmed at end of Phase 2

Manual checkpoint triggers:
4. manual_save — user clicks Save Checkpoint in UI
5. user_stopped — user clicks Stop

Each checkpoint contains:
- Full output/ directory snapshot at that point
- Active memory snapshot
- One-paragraph summary: "Built auth module. Decided on stateful JWT
  with Redis blacklist after human resolved conflict in session 4."
- Git-style diff from previous checkpoint (if applicable)
```

---

## Tech Stack

```
FRONTEND:   Next.js 14 (App Router) + TypeScript (strict) + Tailwind CSS
BACKEND:    Next.js API Routes (same repo, one Vercel deployment)
            SSE (Server-Sent Events) for pipeline streaming
DATABASE:   Neon PostgreSQL (2 tables: users, api_credentials)
AUTH:       Clerk (handles all auth UI and session management)
CACHE:      Upstash Redis
              - Pipeline state during active session
              - Rate limiting per user per endpoint
              - Budget counters per user per month
              - Pause state (24h TTL)
LOCAL:      File System Access API (browser) for project folders
HOSTING:    Vercel (frontend + API routes together)
MONITORING: Sentry (errors, never log API keys or user code)
```

---

## UI Layout

The main application has a three-panel layout on desktop:

```
┌─────────────────────────────────────────────────────────────────┐
│ CRUCIBLE                          Budget: $16.60 ●  [Pause] [Stop]│
├──────────────┬──────────────────────────┬───────────────────────┤
│              │                          │                       │
│  PROJECTS    │   CONVERSATION TAB       │    OUTPUT LAYER       │
│              │                          │                       │
│  project 1   │  14:23:01 ✓ Phase 1     │  auth_login.ts        │
│  project 2   │  14:23:09 ⚠ Alignment  │  auth_logout.ts       │
│  project 3   │  14:24:00 ◎ Dialogue   │                       │
│  + new       │  14:27:12 ✓ Spec ok    │  ── Review list ──    │
│              │  14:27:18 → Round 1... │  ⚠ Timing attack      │
│              │  14:27:28 ✗ No consens │  ⚠ Race condition     │
│              │  14:27:45 → Round 2... │                       │
│              │  14:27:59 ✓ Complete   │  ── Diff view ──      │
│              │                          │  + 12 lines added     │
│              │  [Interrupt pipeline]    │  - 3 lines removed    │
│              │  > type here...          │                       │
└──────────────┴──────────────────────────┴───────────────────────┘
```

**Left panel — Projects:**
- List of all user projects
- Current project highlighted
- Free tier shows 3 max with upgrade prompt on 4th
- Create new project button

**Center panel — Conversation tab:**
- Timeline of every pipeline event (collapsed by default)
- Human input box always visible at the bottom
- Any text typed here is a HUMAN OVERRIDE
- Phase transition indicators visible without expanding
- Current activity shown with → indicator and live animation
- Each entry expandable to see full model exchange
- Download full trace button at the top right

**Right panel — Output layer:**
- Only shows consensus-validated code files
- Code viewer with syntax highlighting (Monaco editor, read-only)
- Diff view from previous version
- Review list (low-confidence flags, cumulative)
- Change log for current module

**Phase screens (replace center + right panels during phases 1, 1.5, 2):**

Phase 1 screen (full width):
```
ANALYZING YOUR REQUIREMENTS

DeepSeek  ████████████████████  Thinking...  (6s)
Claude    ██████████░░░░░░░░░░  Thinking...  (3s)

Both models analyzing your prompt and codebase context.
You will be asked questions once this is complete.
```

Phase 1.5 screen (full width):
```
MODELS ALIGNING

DeepSeek: "I understood this as stateless JWT..."
Claude:   "I assumed stateful sessions..."
⚠ Architectural difference detected — preparing question for you
```

Phase 2 screen (full width — the question dialogue):
Full-width centered layout for maximum readability.
Questions in their groups with progress indicator.

**Mobile layout (single column, tabs at bottom):**
- Projects tab
- Conversation tab (default active)
- Output tab
- Budget tab

---

## Database Schema

Two tables only. Do not add tables without explicit discussion.

```sql
-- Table 1: users
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  plan          TEXT NOT NULL DEFAULT 'free'
                     CHECK (plan IN ('free', 'indie', 'pro', 'team')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  clerk_user_id TEXT NOT NULL UNIQUE
);

-- Table 2: api_credentials
CREATE TABLE api_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
                -- 'anthropic' | 'openai' | 'deepseek' | 'google'
                -- 'mistral' | 'openrouter' | 'groq' | 'together'
  encrypted_key TEXT NOT NULL,
                -- AES-256-GCM encrypted, never plaintext
  is_valid      BOOLEAN NOT NULL DEFAULT false,
                -- set to true after successful validation API call
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
  -- one key per provider per user
  -- updating key = delete old row, insert new row
);
```

Billing table intentionally excluded from V1.
Add only when Stripe integration begins and first user wants to pay.

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

New provider = one new adapter class implementing ModelAdapter interface.
Zero changes to pipeline, phases, orchestration, or routing logic.

---

## API Routes Structure

Every route returns: `{ success: boolean, data?: T, error?: string }`

```
AUTH
POST  /api/auth/webhook              Clerk webhook → create user row in DB

CREDENTIALS
GET   /api/credentials               List user's connected providers
POST  /api/credentials               Encrypt, validate, and store new key
DELETE /api/credentials/:id          Remove key

PROJECTS
GET   /api/projects                  List projects (reads local FS manifest)
POST  /api/projects                  Create new project folder structure
GET   /api/projects/:id              Get project config + active memory

PHASE 0
POST  /api/pipeline/context          Submit codebase context before thinking

PHASE 1 — SILENT THINKING
POST  /api/pipeline/think            Trigger parallel thinking (both models)
GET   /api/pipeline/think/stream     SSE: stream thinking progress to UI

PHASE 1.5 — ALIGNMENT CHAT
POST  /api/pipeline/align            Run alignment chat (max 2 rounds)
GET   /api/pipeline/align/stream     SSE: stream alignment chat to UI

PHASE 2 — QUESTIONS
GET   /api/pipeline/questions        Get compiled grouped question set
POST  /api/pipeline/questions/answer Submit all user answers
POST  /api/pipeline/questions/second-pass  Run second-pass after answers
POST  /api/pipeline/contradictions/resolve Resolve inline contradiction
GET   /api/pipeline/spec             Get expanded spec document
POST  /api/pipeline/spec/confirm     Lock spec and trigger Phase 3

PHASE 3 — GENERATION LOOP
POST  /api/pipeline/generate         Trigger generation for current module
GET   /api/pipeline/stream           SSE: stream full pipeline activity
POST  /api/pipeline/interrupt        Inject human override to both models
POST  /api/pipeline/resolve          Human resolves 3-round escalation
POST  /api/pipeline/pause            Freeze pipeline, save state to Redis
POST  /api/pipeline/play             Resume from frozen state
POST  /api/pipeline/stop             Kill pipeline, save everything cleanly

OUTPUT
GET   /api/output/:sessionId         Get consensus-validated code
GET   /api/output/:sessionId/diff    Get diff from previous version
GET   /api/output/:sessionId/review  Get low-confidence review list

CONVERSATION TAB
GET   /api/conversation/:sessionId        Get all events (paginated, collapsed)
GET   /api/conversation/:sessionId/:eventId  Get full content of one event
POST  /api/conversation/:sessionId/:eventId/edit  Edit a model prompt (triggers re-run)
POST  /api/conversation/:sessionId/:eventId/reply  Human reply to specific entry

BUDGET
GET   /api/budget                    Current month budget status and projection
```

---

## Environment Variables

```bash
# Clerk Auth
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
CLERK_WEBHOOK_SECRET=

# Neon Database
DATABASE_URL=

# Upstash Redis
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Encryption for API keys (generate: openssl rand -hex 32)
ENCRYPTION_KEY=

# Sentry Monitoring
NEXT_PUBLIC_SENTRY_DSN=
SENTRY_AUTH_TOKEN=

# App URL
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

---

## Business Model

```
FREE TIER (all pipeline features, no capability gating):
├── 3 projects maximum
├── 30 day session history
├── Community support only
└── Upgrade trigger: attempting project 4 shows savings dashboard
    "You have built 3 projects saving approximately $X vs Claude Pro.
     Upgrade for $12/month to continue." — show the number, not a feature list

INDIE ($12/month):
├── Unlimited projects
├── 90 day session history
└── Email support

Future tiers added only when user demand justifies:
├── Pro ($24/month) — advanced analytics, priority routing, early model access
└── Team ($49/month for 3 seats) — shared projects, team dashboard
```

---

## Session Log Format (jsonl — every line is a valid JSON object)

```json
{"ts":"2026-05-30T14:23:01Z","type":"phase_start","phase":"thinking","session_id":"..."}
{"ts":"2026-05-30T14:23:04Z","type":"model_output","model":"deepseek-v4-pro","role":"thinking","tokens_in":1240,"tokens_out":890,"content_hash":"..."}
{"ts":"2026-05-30T14:23:06Z","type":"model_output","model":"claude-sonnet-4-6","role":"thinking","tokens_in":1240,"tokens_out":1102,"content_hash":"..."}
{"ts":"2026-05-30T14:23:09Z","type":"phase_start","phase":"alignment","round":1}
{"ts":"2026-05-30T14:23:14Z","type":"alignment_message","model":"deepseek-v4-pro","round":1,"understood_as":"stateless JWT"}
{"ts":"2026-05-30T14:23:17Z","type":"alignment_message","model":"claude-sonnet-4-6","round":1,"understood_as":"stateful session"}
{"ts":"2026-05-30T14:23:20Z","type":"alignment_conflict","topic":"architecture","deepseek_position":"stateless","claude_position":"stateful"}
{"ts":"2026-05-30T14:23:22Z","type":"question_generated","id":"q_001","topic":"architecture","source":"alignment_conflict"}
{"ts":"2026-05-30T14:26:41Z","type":"user_answer","question_id":"q_001","answer":"stateful_with_redis"}
{"ts":"2026-05-30T14:26:42Z","type":"spec_written","spec_hash":"...","items":12,"edge_cases":8,"test_cases":20}
{"ts":"2026-05-30T14:26:58Z","type":"spec_confirmed","human":true}
{"ts":"2026-05-30T14:27:01Z","type":"generation_start","module":"auth_login","round":1}
{"ts":"2026-05-30T14:27:18Z","type":"generation_output","model":"deepseek-v4-pro","tokens_in":8420,"tokens_out":1840}
{"ts":"2026-05-30T14:27:19Z","type":"self_check","passes":2,"issues_found":1,"issues_fixed":1}
{"ts":"2026-05-30T14:27:28Z","type":"review_output","model":"claude-sonnet-4-6","round":1,"consensus":false,"flags_high":2,"flags_low":1}
{"ts":"2026-05-30T14:27:45Z","type":"generation_start","module":"auth_login","round":2}
{"ts":"2026-05-30T14:27:58Z","type":"review_output","model":"claude-sonnet-4-6","round":2,"consensus":true,"flags_low":1}
{"ts":"2026-05-30T14:27:59Z","type":"output_promoted","module":"auth_login","review_list_items":1}
{"ts":"2026-05-30T14:27:59Z","type":"checkpoint","trigger":"module_complete","summary":"Built auth login. JWT with Redis blacklist. User decided on 5-attempt lockout."}
```

content_hash is SHA256 of the actual content — never log the content itself.

---

## What Has Been Deliberately Left Out of V1

Do not add these without explicit discussion:

```
Infrastructure:
- Billing / Stripe integration — no users paying yet
- Checkpoint automation — manual save only for now
- Team / multi-seat features — after Product-Market Fit

Performance:
- LLMLingua prompt compression — V2 after MVP ships
- ACON self-improving compression — V2
- Archive memory compression engine — manual rules only for now
- Abstraction-level router (function vs module vs architecture review) — V2

Platform:
- VS Code extension — web first
- Desktop app (Tauri/Electron) — web first
- Mobile support — desktop use case only
- Model fine-tuning — uses standard API only
- Shared project links — local storage model for now
- Advanced analytics dashboard — basic budget view only for V1
```

---

## Code Style Rules

```
TypeScript strict mode — no any, no as any, no ts-ignore
Zod validates all external data:
  - API request bodies
  - Model API responses
  - Local file reads (memory.json, spec.json)
  - User-provided values

API routes:
  return { success: true, data: T } on success
  return { success: false, error: "human readable message" } on failure
  never return stack traces or internal error details to client

Model calls:
  always async/await with try/catch
  always have retry logic with exponential backoff (3 retries max)
  always have timeout (120 seconds for generation, 60 for review)
  always estimate and log token cost after each call

Logging:
  never log: API keys, decrypted credentials, user code, user prompts
  always log: timestamps, token counts, model used, phase, round number
  console.log only in development (NODE_ENV check)
  Sentry for production errors

Error messages shown to user:
  always human-readable
  never expose internal error details
  never expose model API error messages verbatim
  always suggest what the user can do next
```

---

## When In Doubt

The pipeline is the product. The models are pluggable.
When adding any feature ask: does this serve the pipeline or is it a distraction?

Every phase exists for a reason documented in this file.
Every rule exists to prevent a specific failure mode documented in this file.
Before removing or weakening any rule, find the failure mode it prevents
and confirm the failure mode no longer applies.

The spec.json is sacred. The output layer is sacred.
Nothing enters either without passing through the full pipeline.