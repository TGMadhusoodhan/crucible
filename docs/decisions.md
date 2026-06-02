# Architectural Decisions

Append-only. Every significant decision and its reasoning.

---

## D001 — Model Adapter Pattern
**Decision:** Every model implements a uniform `ModelAdapter` interface. The pipeline never knows which company made the model.
**Reason:** Provider-agnostic pipeline. New providers = new adapter class, zero pipeline changes.
**Date:** 2026-05-29

## D002 — Reviewer Returns Pseudo-Code Only
**Decision:** Reviewer model NEVER writes full code. Structured JSON with pseudo-code hints (max 3 lines) only.
**Reason:** Full code from reviewer = second primary = API budget exhausts in hours. Pseudo-code costs ~50-100 tokens vs ~2000 for full rewrites.
**Date:** 2026-05-29

## D003 — Two-Tier Memory
**Decision:** Active memory (always injected, <8k tokens) + archive memory (injected on demand). Never collapse.
**Reason:** Context efficiency. Active = what's needed every session. Archive = historical reference only when relevant.
**Date:** 2026-05-29

## D004 — Session History = Token Count, Not Message Count
**Decision:** Load last 40,000 tokens of session log on resume. Not last N messages.
**Reason:** Code-heavy sessions have fewer but longer messages. Token budget is the right unit.
**Date:** 2026-05-29

## D005 — Conflict = Immediate Human Escalation
**Decision:** First model conflict → surface to human immediately. No round-based model debate.
**Reason:** Prevents models from reasoning each other into wrong positions. Human is the tiebreaker.
**Format:** "Primary: [one line]. Reviewer: [one line]. Your call?"
**Date:** 2026-05-29

## D006 — API Keys Encrypted AES-256-GCM
**Decision:** Keys encrypted before DB write. Decrypted only at API call time, in memory only. Never logged.
**Reason:** Security requirement. Keys stored encrypted in `api_credentials.encrypted_key`.
**Date:** 2026-05-29

## D007 — Exactly Two Database Tables (V1)
**Decision:** Only `users` and `api_credentials` tables. No billing table until Stripe integration begins.
**Reason:** YAGNI. Billing added only when users are actually paying.
**Date:** 2026-05-29

## D008 — Output Layer = Consensus Only
**Decision:** Code only reaches output layer when `consensus: true` in ReviewPayload.
**Reason:** The output layer is sacred — it is what the user ships from.
**Date:** 2026-05-29

## D009 — Human Override Is Top Priority
**Decision:** Human typing in conversation layer → inject as "HUMAN OVERRIDE: [message]. All prior reasoning subordinate. Acknowledge explicitly before continuing."
**Reason:** Prevents the "noted, however..." failure mode where models acknowledge but don't actually anchor.
**Date:** 2026-05-29

## D010 — Next.js 16 Proxy (not middleware)
**Decision:** `src/proxy.ts` is the correct middleware file. `middleware.ts` is deprecated in Next.js 16.
**Reason:** Next.js 16 renamed middleware to proxy. The file convention changed.
**Date:** 2026-05-29

## D011 — Default Model Pairing
**Decision:** Primary = DeepSeek V4 Pro, Reviewer = Claude Sonnet 4.6 (or GPT-4o).
**Reason:** DeepSeek 80.6% SWE-bench at $0.565/M blended. Claude Sonnet = different training family = genuine blind spot coverage. 36x cheaper than all-Claude.
**Date:** 2026-05-29

## D012 — Budget Governor in Redis
**Decision:** Per-user monthly spend tracked in Upstash Redis. Four modes: FULL/EFFICIENT/CONSERVATION/CRITICAL.
**Reason:** Redis is fast for per-request counter updates. DB writes would be too slow and expensive.
**Date:** 2026-05-29

## D013 — session_log.jsonl is Append-Only
**Decision:** Session log is JSONL format. Never overwrite. Never delete entries. Append only.
**Reason:** Audit trail, debugging, context restoration. Immutability prevents accidental data loss.
**Date:** 2026-05-29

## D014 — Clerk v7 + Next.js 16 Compatibility
**Decision:** Keep `export default clerkMiddleware(...)` in proxy.ts. Clerk v7 does not export clerkProxy.
**Reason:** Next.js 16 proxy accepts both default and named exports. clerkMiddleware default export is valid.
**Date:** 2026-05-29
