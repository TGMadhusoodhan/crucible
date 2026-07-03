# Crucible Build Log

Append-only. Never overwrite. Each session adds a new entry.

---

## Session 2026-05-29

### Completed
- Read CLAUDE.md and AGENTS.md fully
- Confirmed Next.js 16.2.6 (middleware renamed to proxy.ts — already in place)
- Confirmed all environment variables present in .env.local
- Confirmed all dependencies installed (Clerk, Neon, Upstash, OpenAI, Anthropic, Drizzle, Zod, Sentry)
- Created docs/ memory folder with all 5 files
- STEP 1: Created full src/ project structure

### Files Created
- docs/build_log.md — this file
- docs/current_step.md — step tracking
- docs/decisions.md — architectural decisions
- docs/open_issues.md — bugs/blockers
- docs/session_notes.md — session scratch pad
- src/types/index.ts — all core TypeScript types from CLAUDE.md
- src/lib/utils/index.ts — shared utility placeholder
- src/lib/crypto/index.ts — AES-256-GCM placeholder (STEP 4)
- src/lib/db/schema.ts — Drizzle schema placeholder (STEP 2)
- src/lib/db/index.ts — Neon connection placeholder (STEP 2)
- src/lib/adapters/base.ts — ModelAdapter interface (STEP 6)
- src/lib/adapters/index.ts — factory function placeholder (STEP 6)
- src/lib/pipeline/index.ts — pipeline orchestrator placeholder (STEP 7)
- src/lib/memory/filesystem.ts — local FS layer placeholder (STEP 9)
- src/lib/budget/index.ts — budget governor placeholder (STEP 10)
- src/store/index.ts — client state placeholder
- src/app/(auth)/layout.tsx — auth route group layout
- src/app/(auth)/sign-in/[[...sign-in]]/page.tsx — Clerk sign-in page (moved from root)
- src/app/(auth)/sign-up/[[...sign-up]]/page.tsx — Clerk sign-up page (moved from root)
- src/app/(dashboard)/layout.tsx — dashboard route group layout
- src/app/(dashboard)/dashboard/page.tsx — main dashboard placeholder
- src/app/(dashboard)/projects/page.tsx — projects list placeholder
- src/app/(dashboard)/settings/page.tsx — settings placeholder
- src/app/api/auth/webhook/route.ts — Clerk webhook placeholder (STEP 3)
- src/app/api/credentials/route.ts — credentials CRUD placeholder (STEP 5)
- src/app/api/credentials/[id]/route.ts — DELETE credential placeholder (STEP 5)
- src/app/api/projects/route.ts — projects list/create placeholder (STEP 8)
- src/app/api/projects/[id]/route.ts — project detail placeholder (STEP 8)
- src/app/api/pipeline/start/route.ts — pipeline start placeholder (STEP 8)
- src/app/api/pipeline/message/route.ts — pipeline message placeholder (STEP 8)
- src/app/api/pipeline/stream/route.ts — pipeline SSE stream placeholder (STEP 8)
- src/app/api/pipeline/interrupt/route.ts — human override placeholder (STEP 8)
- src/app/api/pipeline/resolve/route.ts — conflict resolve placeholder (STEP 8)
- src/app/api/pipeline/pause/route.ts — pause placeholder (STEP 8)
- src/app/api/pipeline/play/route.ts — play placeholder (STEP 8)
- src/app/api/pipeline/stop/route.ts — stop placeholder (STEP 8)
- src/app/api/output/[sessionId]/route.ts — consensus code output placeholder (STEP 8)
- src/app/api/budget/route.ts — budget status placeholder (STEP 10)

### Files Modified
- src/app/layout.tsx — updated metadata to Crucible, dark theme default
- src/app/page.tsx — Crucible landing page (minimal placeholder)

### Decisions Made
- Next.js 16: middleware renamed to proxy — src/proxy.ts is the correct file (not middleware.ts)
- Clerk v7 uses `clerkMiddleware` + `export default` — compatible with Next.js 16 proxy
- All env vars already configured — no setup needed before Step 2
- Route groups: (auth) for sign-in/sign-up, (dashboard) for app pages

### Left Off At
- STEP 1 COMPLETE: All directories and placeholder files created, TypeScript compiles clean
- STEP 2 COMPLETE: Drizzle schema + Neon connection + migration applied

---

## Session 2026-05-29 (continued — STEP 2)

### Completed
- STEP 2: Database setup complete

### Files Created
- src/lib/db/schema.ts — users + api_credentials tables, check + unique constraints
- src/lib/db/index.ts — Neon HTTP connection, drizzle instance, schema export
- drizzle.config.ts — Drizzle Kit config, dotenv-flow loads .env.local
- drizzle/0000_many_sleeper.sql — generated migration SQL

### Files Modified
- None

### Decisions Made
- drizzle-kit needs dotenv-flow in drizzle.config.ts to read .env.local (Next.js env files not auto-loaded by drizzle-kit)
- Using neon-http driver (not neon-serverless Pool) — correct for API routes / serverless

### Left Off At
- STEP 2 COMPLETE: Both tables live in Neon, migration tracked in drizzle/__journal.json
- STEP 3 NEXT: Auth with Clerk — proxy.ts already in place, webhook handler at /api/auth/webhook

---

## Session 2026-05-31

### Completed
- Fixed conflict resolution hang bug (3 bugs): FINALIZE_MESSAGE missing on sendMessage error, sendToHumanReview fire-and-forget clearConflictInRedis, handleHumanReview now async
- Built per-provider budget system: per-provider spend tracking + caps in Redis, full BudgetBar redesign, BudgetSettings component for settings page

### Files Modified
- src/hooks/usePipeline.ts — fix FINALIZE_MESSAGE on error, make sendToHumanReview async/awaited
- src/components/shared/ConflictModal.tsx — handleHumanReview async, "Moving to output…" loading state
- src/types/index.ts — add ProviderBudget, update BudgetStatus with per-provider breakdown
- src/lib/budget/index.ts — per-provider spend tracking (Redis), setProviderCap, recordUsage now takes provider param
- src/app/api/budget/route.ts — PATCH now handles { provider, capUsd } for per-provider caps
- src/app/api/pipeline/message/route.ts — pass primaryProvider to recordUsageFromText
- src/components/shared/BudgetBar.tsx — full redesign: collapsible top bar + per-provider rows with inline cap editors
- src/app/(dashboard)/settings/page.tsx — added BudgetSettings component
- src/components/shared/BudgetSettings.tsx — NEW: full per-provider limit management UI for settings page

### Left Off At
- Step 11 COMPLETE. Budget system is now per-provider. TypeScript compiles clean.

---

## Session 2026-05-31 (bug fixes)

### Completed
- Fixed stop/pause buttons not working
- Fixed reviewer feedback loop (DeepSeek ignoring Claude's fixes)
- Added copy buttons to code blocks in conversation panel

### Files Modified
- src/hooks/usePipeline.ts — added AbortController refs (abortRef, streamingIdRef); stop/pause now abort in-flight SSE stream synchronously; fixWithHints now includes code inline in fix prompt instead of "the code above"; AbortError handled cleanly in catch blocks
- src/components/conversation/ConversationPanel.tsx — added parseContent() to detect ```lang\n...\n``` blocks; added CodeBlock component with copy button; Message component now renders code blocks with copy button instead of raw <pre>

### Decisions Made
- stop/pause abort the fetch immediately (synchronous) then fire API update as background fire-and-forget — UI is instant, no waiting on network
- Fix prompt includes the code literally inline — "the code above" was too vague, model was regenerating from scratch instead of patching
- Code block detection: regex on ``` fences, renders with dark background + Copy button per block

### Left Off At
- All 3 bugs fixed. TypeScript compiles clean.

---

## Session 2026-05-31 — Architecture Upgrade to 4-Phase Pipeline

### Decision
User confirmed: upgrade to 4-phase pipeline (think → align → questions/spec → generate).
This is the core product differentiator. Old simple pipeline replaced.

### Completed (Steps 6–7 of new build plan)

**Step 6 — Types (COMPLETE)**
- src/types/index.ts — complete rewrite for 4-phase architecture
  - ThinkingOutput + thinkingOutputSchema (Zod)
  - Assumption, QuestionCategory, QuestionOption, Question
  - AlignmentMessage, AlignmentResult
  - Contradiction, ContradictionResolution
  - SpecDocument (AcceptanceCriterion, EdgeCase, ErrorScenario)
  - SelfCheckIssue, SelfCheckOutput + selfCheckOutputSchema (Zod)
  - ReviewFlag, ReviewPayload + reviewPayloadSchema (Zod)
  - ConsensusOutput, PipelineContext
  - ModelAdapter interface with 5 methods: think, chat, generate, selfCheck, review
  - PipelinePhase (18 states), PipelineConfig, PipelineSessionState
  - ConversationEvent + all event types
  - SSEEvent union type
  - Budget types (kept from before)

**Step 7 — Adapters (COMPLETE)**
- src/lib/adapters/base.ts — full rewrite
  - 5 system prompts: THINKING, ALIGNMENT, GENERATION, SELF_CHECK, REVIEWER
  - Parsers: parseThinkingOutput, parseSelfCheckOutput, parseReviewPayload (all Zod-validated)
  - Prompt builders: buildThinkingPrompt, buildAlignmentPrompt, buildGenerationPrompt,
    buildSelfCheckPrompt, buildReviewPrompt
  - phaseLabel() helper for logging
  - BaseAdapter abstract class with all 5 method signatures
- src/lib/adapters/openai-compatible.ts — full rewrite; all 5 methods implemented
- src/lib/adapters/claude.ts — full rewrite; all 5 methods implemented
- src/lib/adapters/google.ts — full rewrite; all 5 methods implemented
- src/lib/adapters/deepseek.ts, openai.ts, mistral.ts, openrouter.ts — unchanged (extend openai-compatible)

### Files Stubbed (will be replaced in Step 12)
- All /api/pipeline/* routes → 501 stubs
- /api/output/[sessionId]/route.ts → 501 stub
- src/lib/pipeline/index.ts → empty stub

### Decisions Made
- FileTree circular type fixed: use { [key: string]: string | FileTree } not Record<...>
- test-pipeline.mts excluded from tsconfig (dev scratch file)
- Old pipeline routes stubbed with 501 handlers (replaced in Step 12)

### Left Off At
- Steps 6–7 COMPLETE. TypeScript compiles clean (zero errors in source).
- NEXT: Step 8 — Memory utilities (filesystem.ts, active-memory.ts, archive-memory.ts, session-log.ts)

---

## Session 2026-05-31 — Step 8 Complete

### Completed

**Step 8 — Memory + Session Log Utilities (COMPLETE)**

Files created/updated:
- src/lib/memory/filesystem.ts — updated: writeSpec() (write-once guard), readSpec(), specExists(), appendReviewList(), readReviewList(), writeOutput() alias, initProject() alias, saveCheckpoint() now typed with trigger union
- src/lib/memory/session-log.ts — NEW: typed ConversationEvent builders for every pipeline event type: logPhaseStart, logThinkingDone, logAlignmentMessage, logAlignmentConflict, logQuestionsReady, logUserAnswers, logSpecWritten, logSpecConfirmed, logGenerationStart, logGenerationDone, logSelfCheck, logReview, logOutputPromoted, logHumanOverride, logConflictEscalated, logPause, logPlay, logStop, logBudgetModeChange
- src/lib/memory/active-memory.ts — NEW: 8k token limit, serializeActiveMemory(), addDecision(), setCurrentModule(), addConflict(), resolveConflict(), compressActiveMemory(), needsCompression()
- src/lib/memory/archive-memory.ts — NEW: archiveModule(), markDeprecated(), addArchitectureNote(), serializeArchiveSection(), estimateArchiveTokens()
- src/lib/utils/tokens.ts — NEW: estimateTokens(), estimateTokensFromMessages(), truncateToTokenLimit(), trimHistoryToTokenLimit(), estimateCost()
- src/lib/utils/retry.ts — NEW: retryWithBackoff() (3 retries, 1s/2s/4s, skips 401/404), withTimeout(), retryWithTimeout(), TIMEOUT_GENERATE_MS (120s), TIMEOUT_DEFAULT_MS (60s)
- src/lib/utils/index.ts — re-exports from retry.ts and tokens.ts for backward compat

TypeScript: zero errors.

### Left Off At
- Step 8 COMPLETE.
- NEXT: Step 9 — Pipeline Phase Implementations

---

## Session 2026-05-31 — Step 9 Complete

### Completed

**Step 9 — Pipeline Phase Implementations (COMPLETE)**

All 11 files in src/lib/pipeline/:

- phase0-context.ts — runPhase0Context(input): normalize + truncate context (10k token cap)
- phase1-thinking.ts — runPhase1Thinking(): parallel think() on both models, 60s timeout, fires thinking_done SSE events
- phase1-5-alignment.ts — runPhase1_5Alignment(): 2 rounds, mismatch detection via keyword signals + understood_as divergence, conflict→Phase2 required question, deduplicates questions across models
- phase2-questions.ts — runPhase2Questions(): merge+dedup from all sources, second-pass checklist (auth, error handling, persistence), sort required-first by category
- phase2-contradiction.ts — detectContradictions(): keyword-rule table (stateless/session, no-auth/per-user, etc.) on all answer pairs, returns Contradiction[] with resolution options
- phase2-spec.ts — runPhase2Spec(): deterministic SpecDocument from questions+answers, acceptance_criteria/edge_cases/error_messages, writeSpec() write-once guard, dynamic import to avoid circular ref
- phase3-generate.ts — runPhase3Generate(): streaming generation with token emit, max 2 self-check passes, patch mode reuses buildGenerationPrompt with patchInstructions
- phase3-review.ts — runPhase3Review(): reviewer.review(), LOW flags→appendReviewList(), HIGH/MEDIUM in payload, emits review_done
- phase3-consensus.ts — runPhase3Consensus(): promote on consensus, retry if round<3, escalate at round≥3; promoteAfterHumanResolution() for human override path
- human-override.ts — formatHumanOverride(), hasAcknowledgedOverride(), hasDismissedOverride(), injectHumanOverride(), consumePendingOverrides()
- orchestrator.ts — Redis state machine: createSession(), runPipeline() (fully resumable), pause/play/stop/submitAnswers/confirmSpec/resolveConflict, consumeEvents() for SSE stream route
- index.ts — re-exports all pipeline phase files

### Architecture Decisions Made
- Orchestrator is RESUMABLE (not long-running): returns at every human-input gate, called again when user provides input
- Redis keys: pipeline:{sid}:state, pipeline:{sid}:events (RPUSH/LPOP list), pipeline:{sid}:control
- emit() is fire-and-forget (publishEvent to Redis list)
- Self-check pass uses ReviewPayload adapter internally so generate() PATCH MODE handles it
- Spec generation is deterministic (no model call) — quality comes from question quality
- Contradiction detection is keyword-rule-based (no model call) — upgradeable later

### Left Off At
- Step 9 COMPLETE. TypeScript: zero errors.
- NEXT: Step 10 — Conversation Tab Event System

---

## Session 2026-05-31 — Steps 10–11 Complete

### Completed

**Step 10 — Conversation Tab Event System**
- src/lib/conversation/event-log.ts — NEW
  - getSessionEvents(projectId, opts) — filtered/paginated query over session_log.jsonl
  - getEventFullContent(projectId, eventId) — single event full content (expand on click)
  - getEventsSince(projectId, cursorTimestamp) — incremental polling for live updates
  - getPhaseTimeline(projectId) → PhaseGroup[] — groups events by phase for timeline UI
  - getSessionSummary(projectId) → SessionSummary — stats: tokens, cost, phases seen, isComplete
  - serializeEventForSSE(event) / serializeHeartbeat() — SSE wire format helpers
  - filterActivityEvents / filterConflictEvents / filterOverrideEvents / groupReviewsByRound

**Step 11 — Budget Governor integration**
- src/types/index.ts — added userId: string to PipelineSessionState
- src/lib/pipeline/orchestrator.ts:
  - Added userId to StartPipelineParams and createSession()
  - Added recordAndRefreshBudget() — calls recordUsage() fire-and-forget, re-checks budget mode
  - Wired after Phase 1 thinking (primary + reviewer tokens separately)
  - Wired after Phase 3 generate (primary tokens) and Phase 3 review (reviewer tokens)
  - Budget mode change → logBudgetModeChange + SSE event so client re-fetches BudgetBar
  - Fixed provider param bug: was hardcoded to config.primaryProvider, now correctly passes caller's provider

### Left Off At
- Steps 10–11 COMPLETE. TypeScript: zero errors.
- NEXT: Step 12 — API Routes (replace all 501 stubs)

---

## Session 2026-05-31 — Step 12 Complete

### Completed

**Step 12 — All API Routes**

New routes implemented:

- POST /api/pipeline/start — auth + DB key lookup + decrypt + createSession(), returns sessionId
- GET  /api/pipeline/stream — SSE: calls runPipeline(sessionId, directEmit), streams events zero-latency; closes at human-input gates; heartbeat every 15s
- POST /api/pipeline/message — discriminated union: type=answers|confirm_spec|resolve_conflict; advances phase in Redis; client reconnects to stream
- POST /api/pipeline/pause — pauseSession()
- POST /api/pipeline/play — playSession(), client reconnects to stream
- POST /api/pipeline/stop — stopSession()
- POST /api/pipeline/interrupt — injectOverride() queues HUMAN OVERRIDE for next round
- POST /api/pipeline/resolve — resolveConflict(), advances from conflict_escalated
- GET  /api/output/[sessionId] — returns ConsensusOutput + code files + SessionSummary
- GET  /api/conversation/[sessionId] — view=events|timeline|summary + since= polling + eventId= expand
- POST /api/auth/webhook — Clerk user.created/user.deleted → DB upsert; manual HMAC-SHA256 Svix verification (no svix package import due to bundler moduleResolution incompatibility)

### Architectural decisions
- SSE stream IS the pipeline runner — runPipeline(sessionId, externalEmit) emits directly to ReadableStream controller (zero latency, no Redis polling)
- Redis events queue still populated in parallel (for future background jobs / replay)
- Pipeline is re-entrant: returns at every human-input gate; client reconnects after user input
- Message route advances phase in Redis then returns — client is responsible for reconnecting to stream
- accept, clear-conflict routes left as 501 stubs (superseded by 4-phase pipeline)

### Left Off At
- Step 12 COMPLETE. TypeScript: zero errors.
- NEXT: Step 13 — Frontend UI

---

## Session 2026-05-31 — Step 13 Complete

### Completed

**Step 13 — Frontend UI (4-phase pipeline)**

Store rewrite (src/store/index.ts):
- New PipelineState: phase, round, thinkingPrimary/Reviewer, alignmentMessages, questions, userAnswers, contradiction, spec, streamingCode, selfCheckOutput, lastReview, output, conflictReason, isStreaming
- New actions: START_SESSION, SET_PHASE, THINKING_DONE, ALIGNMENT_MSG, QUESTIONS_READY, ANSWER_QUESTION, SET_CONTRADICTION, SPEC_READY, TOKEN, SELF_CHECK_DONE, REVIEW_DONE, CONSENSUS, CONFLICT_ESCALATED, SET_STREAMING, RESET_SESSION

Hook rewrite (src/hooks/usePipeline.ts):
- connectSSE(): reads SSE stream, dispatches all SSEEvent types
- connectToStream(sessionId): re-entrant SSE connection, reconnects after gates
- startPipeline(taskDesc, contextText?): POST start → session → connectToStream
- submitAnswers(answers): POST message type=answers → connectToStream
- confirmSpec(): POST message type=confirm_spec → connectToStream
- resolveConflict(message): POST resolve → connectToStream
- interrupt, pause, play, stop, refreshBudget, answerQuestion, setProject, resetSession

New components (src/components/pipeline/):
- TaskInputPanel.tsx — task input + context textarea + Start Pipeline button
- ThinkingPanel.tsx — two model cards with live status + questions/assumptions count
- AlignmentPanel.tsx — chat bubbles per model per round, conflict detection display
- QuestionsPanel.tsx — question cards with category badges, option radio buttons, recommended highlighting, Submit button gated on required questions
- SpecPanel.tsx — acceptance criteria / edge cases / error messages, Confirm & Generate button
- GeneratingPanel.tsx — streaming code with cursor, self-check status strip, phase step indicators
- ConflictPanel.tsx — escalation reason + unresolved flags + override text input + Apply Decision button
- CompletePanel.tsx — consensus code display with Copy button, low-severity notes count
- PipelineView.tsx — phase router: ProgressStrip + ControlsBar + phase-specific component

Updated:
- ConversationPanel.tsx — rewrote to poll GET /api/conversation/[sessionId] every 3s while active; expandable event rows with lazy fullContent fetch; heartbeat comment skipping
- ProjectNavigator.tsx — selectProject now dispatches SET_PROJECT + RESET_SESSION (no longer starts session — TaskInputPanel does that)
- AppNav.tsx — derives pipelineStatus from phase + isStreaming instead of old field
- OutputPanel.tsx — uses output + phase for conflict indicator
- ConflictModal.tsx — stubbed (superseded by ConflictPanel)
- dashboard/page.tsx — PipelineView | ConversationPanel (removed ConflictModal, OutputPanel moved to CompletePanel)

TypeScript: zero errors.

### Left Off At
- Step 13 COMPLETE. TypeScript: zero errors.
- NEXT: Step 14 — Sentry monitoring

---

## Session 2026-05-31 — Step 14 Complete

### Completed

**Step 14 — Sentry Monitoring**

Files created:
- sentry.client.config.ts — client SDK init: 10% trace sample, 100% on error; session replay; beforeSend strips "api key" mentions
- sentry.server.config.ts — server SDK init: beforeSend drops events with "encrypted_key" in payload
- sentry.edge.config.ts — edge runtime SDK init
- src/instrumentation.ts — Next.js instrumentation hook: loads server/edge configs on correct runtime
- src/lib/sentry.ts — typed capture helpers: capturePipelineError (with phase/round/model context), captureApiError, captureAdapterError
- src/app/global-error.tsx — root error boundary: captures to Sentry, shows Error ID + retry button
- src/app/(dashboard)/error.tsx — dashboard-level error boundary: captures + shows in-layout recovery UI

Files updated:
- next.config.ts — wrapped with withSentryConfig (silent build output, source maps prod-only, no auto-instrumentation)
- src/lib/pipeline/orchestrator.ts — handleError() now calls capturePipelineError with sessionId/projectId/userId/phase/round
- src/app/api/pipeline/start/route.ts — catch block calls captureApiError
- src/app/api/pipeline/stream/route.ts — pipeline error in stream calls captureApiError with userId context

### Decisions
- Removed `hideSourceMaps` (not in SentryBuildOptions v10 — handled by `sourcemaps.disable`)
- Removed `instrumentationHook: true` (stable in Next.js 15+, not in experimental config)
- Simplified `beforeSend` breadcrumb filtering (Sentry v10 types `values` as a function, not array — used JSON.stringify check instead)
- `autoInstrumentServerFunctions: false` — we instrument pipeline phases explicitly, don't want generic route tracing adding noise

### Left Off At
- Step 14 COMPLETE. TypeScript: zero errors.
- NEXT: Step 15 — End-to-end test

---

## Session 2026-05-31 — Step 15 Complete

### Completed

**Step 15 — End-to-End Tests**

test-logic.mts (52 tests, 0 failures — runs with `npx tsx test-logic.mts`, no API keys):
- runPhase0Context: whitespace trimming, empty input, file list header, 10k token truncation
- detectContradictions: stateless↔session match, compatible answers = no contradiction, single/empty answers = no contradiction
- formatHumanOverride: prefix, content, subordination clause, ACK requirement
- hasAcknowledgedOverride: all 5 patterns (Acknowledged, Understood, I acknowledge, Confirmed, will do)
- hasDismissedOverride: "noted however", "understood but" patterns
- consumePendingOverrides: null on empty, single, multi numbered
- estimateTokens: empty, 5-char, 400-char
- truncateToTokenLimit: within budget, adds marker, no mid-word splits, short text unchanged
- trimHistoryToTokenLimit: discards oldest, keeps most recent
- parseThinkingOutput: fallback on bad JSON, correct parse on valid JSON
- parseReviewPayload: truncation detection, valid JSON parse
- parseSelfCheckOutput: fallback and valid path

Bug found and fixed: detectContradictions false positive
- "No session needed" triggered the stateless↔session rule because "session" appears in the negation
- Fixed by adding endorses() helper that checks for no/not/without/non prefix before the keyword
- Rule now only fires when the label positively endorses the keyword

test-pipeline.mts (runs with `DEEPSEEK_KEY=<k> ANTHROPIC_KEY=<k> npx tsx test-pipeline.mts`):
- Full 4-phase pipeline: Phase1 → Phase1.5 → Phase2 (questions+contradictions+spec) → Phase3 (generate+selfcheck+review+consensus)
- Calls real DeepSeek and Claude models
- Auto-answers questions with recommended options
- Reports phase timing, token counts, decision at each stage

tsconfig.json: added test-logic.mts to exclude list

### Left Off At
- Step 15 COMPLETE. All 15 build steps done. TypeScript: zero errors. Logic tests: 52/52.
- BUILD IS COMPLETE. Ready for deployment.

---

## Session 2026-06-02

### Completed
- Fixed: reopening a project did not restore previously generated code
- Implemented local filesystem persistence using File System Access API + IndexedDB (fully browser-side, works on Vercel)

### Files Created
- src/lib/localfs.ts — NEW: IndexedDB handle persistence + File System Access API utilities (pickProjectFolder, getProjectFolder, saveOutputToFolder, readOutputFromFolder, hasFolderLinked)

### Files Modified
- src/store/index.ts — added RESTORE_SESSION action: sets phase→complete, output, spec from local file
- src/components/pipeline/CompletePanel.tsx — auto-saves code + crucible-meta.json to linked folder on consensus; shows "Pick folder & save" button if no folder linked yet
- src/components/shared/ProjectNavigator.tsx — (1) selectProject() now calls readOutputFromFolder → dispatches RESTORE_SESSION if saved output found, RESET_SESSION if not; (2) NewProjectModal now has a step-2 "Link local folder" screen after project creation

### Architecture
- Output saved as two files: output.txt (raw code) + crucible-meta.json (ConsensusOutput + SpecDocument JSON)
- Folder handle stored in IndexedDB under projectFolder:{projectId} — persists across browser sessions
- On project select: reads crucible-meta.json from linked folder → dispatches RESTORE_SESSION → UI shows complete phase with the saved code
- No server changes needed — entirely client-side

### Left Off At
- TypeScript: zero errors. Feature complete.

---

## Session 2026-06-03

### Completed
- Fixed ENOENT crash on Vercel: server filesystem writes are now best-effort (silently swallowed on read-only deployments). Pipeline state lives in Redis; filesystem is supplementary only.
- Removed step-2 "Link local folder" modal from project creation (was blocking on mobile/Firefox/Windows/Mac).
- Implemented cross-device output persistence: ConsensusOutput + spec stored in Redis under `project_output:{userId}:{projectId}` (1-year TTL). Any device can now restore a previously generated session.

### Files Modified
- src/lib/memory/filesystem.ts — added `canWrite()` probe; all write operations (initProject, writeMemory, appendSessionLog, writeSpec, appendReviewList, writeProjectConfig, writeOutput, saveCheckpoint) wrapped in try-catch, silently fail on read-only fs
- src/lib/pipeline/orchestrator.ts — added `StoredProjectOutput` interface, `saveProjectOutput()`, `getProjectOutput()` (Redis, 1-year TTL); call `saveProjectOutput` fire-and-forget when `decision.promote` is true; added `ConsensusOutput, SpecDocument` to top-level type imports
- src/components/shared/ProjectNavigator.tsx — `selectProject()` now fetches `/api/projects/:id/output` (server Redis) instead of local folder; removed step-2 link-folder modal from `NewProjectModal`; cleaned up imports

### Files Created
- src/app/api/projects/[id]/output/route.ts — GET /api/projects/:id/output — returns StoredProjectOutput from Redis for the authenticated user

### Decisions Made
- Output persistence is server-first (Redis) not client-first (IndexedDB). Local folder save in CompletePanel stays as an optional "save to disk" feature for Chrome/Edge desktop users.
- `saveProjectOutput` is fire-and-forget from orchestrator — never blocks consensus promotion.
- 1-year TTL matches project data TTL.

### Left Off At
- TypeScript: zero errors. All pipeline runs now work cross-platform (Vercel, mobile, Windows, Mac, any browser).

---

## Session 2026-06-27

### Completed
- Hybrid local+online generation architecture — type foundation only (no runtime changes)

### Files Modified
- src/types/index.ts — added 'ollama' to Provider, GenerationMode type, FileDefinition/FileManifest interfaces + fileManifestSchema, updated PipelineConfig (generationMode + localModelId/localEndpoint fields), added fileManifest/generatingFileIdx/generatingFilename to PipelineSessionState, added 'phase3_scaffold' to PipelinePhase, added scaffold_ready/file_generating SSEEvents, added scaffold() to ModelAdapter interface
- src/store/index.ts — added FileManifest import, fileManifest/generatingFileIdx/generatingFilename to PipelineState + initialState, SCAFFOLD_READY/FILE_GENERATING actions + reducer cases
- src/hooks/usePipeline.ts — added scaffold_ready/file_generating cases to handleSSEEvent
- src/lib/adapters/base.ts — added concrete scaffold() stub to BaseAdapter (throws not-implemented), added phase3_scaffold to phaseLabel()
- src/lib/adapters/index.ts — added OllamaAdapter (extends OpenAICompatibleAdapter, localhost:11434), added 'ollama' case to getAdapter()
- src/app/api/pipeline/start/route.ts — added generationMode: 'api_only' default to createSession config
- src/app/api/credentials/route.ts — added ollama to validateApiKey configs
- src/app/api/models/[provider]/route.ts — added ollama to MODEL_ENDPOINTS
- src/components/shared/BudgetBar.tsx — added ollama to PROVIDER_LABELS
- src/components/shared/BudgetSettings.tsx — added ollama to PROVIDER_LABELS
- src/components/shared/CredentialsManager.tsx — added ollama to PROVIDER_LABELS
- src/components/shared/ProjectNavigator.tsx — added ollama to PROVIDER_MODELS

### Decisions Made
- scaffold() in BaseAdapter is a concrete stub (throws) not abstract — avoids forcing all 8 existing adapters to implement a method that only online-primary adapters will use in hybrid mode
- OllamaAdapter extends OpenAICompatibleAdapter — Ollama's /v1 API is OpenAI-compatible; apiKey field carries endpoint URL for flexibility
- generationMode defaults to 'api_only' at the API route layer; hybrid mode wiring deferred to Prompt 4

### Left Off At
- Type foundation complete. TypeScript: zero errors.
- NEXT: Prompt 2 — scaffold() implementation in online adapters + phase3_scaffold in orchestrator

---

## Session 2026-06-28

### Completed
- Prompt 2 — BaseAdapter.scaffold() implementation + phase3-scaffold.ts phase runner
- Prompt 3 — OllamaAdapter, getAdapter endpoint param, phase3-generate.ts per-file hybrid loop

### Files Created
- src/lib/adapters/ollama.ts — OllamaAdapter (extends OpenAICompatibleAdapter, estimateCost=0)
- src/lib/pipeline/phase3-scaffold.ts — runPhase3Scaffold() phase runner

### Files Modified
- src/lib/adapters/base.ts — added SCAFFOLD_SYSTEM_PROMPT, callTextCompletion() hook, full scaffold() impl, FileManifest imports
- src/lib/adapters/index.ts — import OllamaAdapter from ./ollama (removed inline), added optional endpoint? 4th param to getAdapter
- src/lib/pipeline/phase3-generate.ts — full rewrite: primary→generator, checker param, manifest-driven per-file PATH B loop, buildPerFilePrompt, runPerFileSelfCheck

### Decisions Made
- callTextCompletion() is a protected concrete method in BaseAdapter (throws by default); concrete adapters override it in Prompt 4 to enable scaffold()
- getAdapter endpoint? falls back to apiKey then default localhost — backward compatible with 3-arg callers
- phase3-generate signature: checker? is optional (not required) so orchestrator's existing (pid,sid,round,ctx,primary,emit,undefined,code) call compiles without change
- PATH B (hybrid) escalates only the FAILING file to the online checker — other files keep their locally generated code

### Ollama Setup
- Installed to ~/.local/bin/ollama v0.30.11
- Server running at http://localhost:11434
- qwen2.5-coder:7b (4.7GB) pulled and verified

### Left Off At
- TypeScript: zero errors on all changes.
- NEXT: Prompt 4 — orchestrator wiring (callTextCompletion in adapters, scaffold phase in runPipeline, hybrid mode routing)

---

## Session 2026-06-28 (continued — Prompt 4)

### Completed
- Prompt 4 — full hybrid mode wiring, end to end

### Files Modified
- src/lib/adapters/claude.ts — added callTextCompletion() (uses this.client.messages.create); scaffold() now works for all Anthropic models
- src/lib/adapters/openai-compatible.ts — added callTextCompletion() (uses this.client.chat.completions.create); OllamaAdapter inherits it automatically
- src/components/shared/ProjectNavigator.tsx — added generation mode pill toggle + hybrid inputs (local model ID, Ollama endpoint, pull hint) in NewProjectModal
- src/components/pipeline/GeneratingPanel.tsx — added phase3_scaffold spinner view, per-file progress strip (done/current/pending pills), header label for hybrid phases; scaffold view replaces code panel entirely during planning
- CLAUDE.md — Prompt 4 status updated to DONE with full detail
- README.md — hybrid setup step 3 corrected (now says "when creating a project"); added note about scaffold view + per-file progress strip

### Decisions Made
- callTextCompletion() added to ClaudeAdapter and OpenAICompatibleAdapter as protected concrete methods — no override keyword (noImplicitOverride not set, consistent with rest of codebase)
- OllamaAdapter inherits callTextCompletion() from OpenAICompatibleAdapter — zero additional code needed in ollama.ts
- Hybrid mode UI lives in NewProjectModal (not a separate project settings page) — consistent with the constraint that generationMode is not stored in the DB projects table
- Per-file progress strip renders only when fileManifest is present — api_only mode renders exactly as before with no visual change

### Left Off At
- Hybrid mode architecture complete: Prompts 1–4 all DONE.
- TypeScript: zero errors.
- NEXT: smoke test or next feature

---

## Session 2026-07-03

### Completed
- Code review of entire uncommitted diff (Prompts 1–4 batch)
- **Removed hybrid / Ollama mode completely** — user decision
- Applied critical/high code review fixes

### Files Deleted
- `src/lib/adapters/ollama.ts` — OllamaAdapter removed
- `src/lib/pipeline/phase3-scaffold.ts` — scaffold phase removed
- `src/lib/pipeline/phase3-coder-fix.ts` — coder-fix removed; orchestrator reverts to runPhase3ReviewerEdit
- `src/app/api/pipeline/accept/route.ts` — dead 410 stub
- `src/app/api/pipeline/clear-conflict/route.ts` — dead 410 stub

### Files Modified
- `src/lib/debug.ts` — added `process.env.NODE_ENV !== 'production'` guard; CRUCIBLE_DEBUG=1 enables in prod
- `src/types/index.ts` — removed GenerationMode, FileManifest, FileDefinition, fileManifestSchema, scaffold()/coderFix() from ModelAdapter, phase3_scaffold from PipelinePhase, scaffold_ready/file_generating from SSEEvent, fileManifest/generatingFileIdx/generatingFilename from PipelineSessionState, generationMode/localModelId/localEndpoint from PipelineConfig, ollama from Provider
- `src/lib/adapters/base.ts` — removed SCAFFOLD_SYSTEM_PROMPT, CODER_FIX_SYSTEM_PROMPT, buildCoderFixPrompt, callTextCompletion hook, scaffold(), coderFix() from BaseAdapter; FileManifest import removed
- `src/lib/adapters/index.ts` — removed OllamaAdapter, endpoint? param, 'ollama' case
- `src/lib/adapters/claude.ts` — removed callTextCompletion()
- `src/lib/adapters/openai-compatible.ts` — removed callTextCompletion()
- `src/lib/pipeline/orchestrator.ts` — removed hybrid wiring, scaffold phase, reverted to runPhase3ReviewerEdit, simplified runPhase3Generate call, removed canHybrid from confirmSpec
- `src/lib/pipeline/phase3-generate.ts` — removed PATH B (per-file loop), removed generator/checker split, removed buildPerFilePrompt/runPerFileSelfCheck, clean single-adapter signature
- `src/app/api/pipeline/start/route.ts` — removed generationMode/localModelId/localEndpoint from schema
- `src/app/api/credentials/route.ts`, `src/app/api/models/[provider]/route.ts` — removed ollama entries
- `src/components/shared/BudgetBar.tsx`, `BudgetSettings.tsx`, `CredentialsManager.tsx` — removed ollama from PROVIDER_LABELS
- `src/components/shared/ProjectNavigator.tsx` — removed ollama from PROVIDER_MODELS, removed generationMode state, removed hybrid UI block
- `src/components/pipeline/GeneratingPanel.tsx` — removed scaffold view, per-file progress strip, isScaffold logic, fileManifest/generatingFilename references
- `src/store/index.ts` — removed FileManifest import, fileManifest/generatingFileIdx/generatingFilename from state, SCAFFOLD_READY/FILE_GENERATING actions
- `src/hooks/usePipeline.ts` — removed scaffold_ready/file_generating handlers, removed hybrid fields from startPipeline body

### Decisions Made
- Hybrid/Ollama mode removed — user decision; not needed for V1
- Reverted orchestrator to use runPhase3ReviewerEdit (reviewer produces hunks) instead of runPhase3CoderFix
- debug.ts kept (production-gated with CRUCIBLE_DEBUG=1 override)
- phase3-reviewer-edit.ts kept as the edit mechanism

### Left Off At
- TypeScript: zero source errors
- All hybrid code eliminated from codebase
