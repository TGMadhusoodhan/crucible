# Crucible — Dev Log

All changes made after the initial build. Most recent first.

---

## 2026-05-31

### AppNav — Active project indicator

**What changed:** `src/components/shared/AppNav.tsx`

The nav bar had no way to tell which project was open. Added a centred pill in the nav bar that shows the active project name and a live status dot.

- **No project open:** faint hint text — "No project open — select one from the left panel"
- **Project open:** pill with coloured dot + project name + status label
  - `idle` → dim zinc dot
  - `running` → blue pulsing dot
  - `paused` → yellow dot
  - `waiting_conflict` → orange pulsing dot
  - `stopped` → red dot

The UserButton was moved into the right nav group so the project pill stays truly centred.

---

### 429 false-positive on session start

**What changed:** `src/app/api/pipeline/start/route.ts`

**Problem:** When a user clicked a project to open it, the `verifyModelAccess` function probed `GET /v1/models` on each provider to validate the API key. If Anthropic returned 429 (rate limited — usually because a pipeline had just been running), the generic fallback fired:

```
"Reviewer model: anthropic returned HTTP 429 — check your API key in Settings"
```

This was wrong. A 429 means Anthropic is temporarily throttled, not that the key is invalid.

**Fix:** 429 on the models probe now returns `null` (pass, don't block session start). The pipeline will surface real errors if the key is actually broken. Same treatment for any other unexpected non-4xx status — don't block the user over a transient probe failure.

---

### Per-provider budget system

**What changed:**
- `src/types/index.ts` — added `ProviderBudget` interface, updated `BudgetStatus`
- `src/lib/budget/index.ts` — full rewrite with per-provider spend + caps in Redis
- `src/app/api/budget/route.ts` — PATCH now accepts `{ provider, capUsd }` to set per-provider caps
- `src/app/api/pipeline/message/route.ts` — `recordUsageFromText` now receives `primaryProvider`
- `src/components/shared/BudgetBar.tsx` — full redesign
- `src/components/shared/BudgetSettings.tsx` — new component in settings page
- `src/app/(dashboard)/settings/page.tsx` — added `BudgetSettings` section
- `src/lib/utils/index.ts` — added `applyCapToBudget` pure helper

**What it does:**

Before: one global $50 hardcoded cap for all models combined.

After: per-provider monthly spending caps, set by the user inside Crucible.

- **Top bar** shows total cap (sum of all configured limits) and total spent. Progress bar reflects that. Mode badge (FULL / EFFICIENT / CONSERVATION / CRITICAL) updates based on % remaining against the total cap.
- **Expand arrow** opens a per-provider section. Each connected provider gets a row with:
  - Progress bar (green → yellow → orange → red as usage rises)
  - `$spent / $cap` figures
  - Remaining amount in colour-coded text
  - Inline cap editor — click the cap value, type a new number, press Enter
  - Remove cap (✕) button
- **"+ Add provider limit"** row lets the user pick any unconfigured provider from a dropdown and set a cap without leaving the bar.
- **Settings page** has the same data as a full-size card layout with Edit / Remove buttons and `+ Set limit` for unconfigured providers.

**Redis keys added:**
```
budget:{userId}:provider:{provider}:spend:{yearMonth}   — per-provider monthly spend
budget:{userId}:provider:{provider}:cap                 — user-set cap per provider
```

**Optimistic updates:** setting or changing a cap updates the UI instantly (`applyCapToBudget` computes the new state locally before the network round-trip). The PATCH + GET still happen in the background to sync Redis. Prevents the 400–1000ms lag that was visible before.

---

### Conflict resolution hang — three bugs fixed

**What changed:** `src/hooks/usePipeline.ts`, `src/components/shared/ConflictModal.tsx`

**Bug 1 — Ghost streaming message (`sendMessage`)**

When `sendMessage` sent a request and the server returned a non-OK response (e.g. 409 "Resolve the conflict first"), `ADD_ASSISTANT_MESSAGE` had already been dispatched (setting `pipelineStatus: 'running'`), but `FINALIZE_MESSAGE` was never called. The assistant message stayed `isStreaming: true` forever — a pulsing loading dot that never cleared. Fixed by calling `FINALIZE_MESSAGE` before `SET_ERROR` in both the non-OK branch and the outer catch.

**Bug 2 — Silent fire-and-forget breaks follow-up messages (`sendToHumanReview`)**

When the user chose "I'll review" in the conflict modal, `clearConflictInRedis()` was called with `void` (fire-and-forget). If that call failed, Redis kept the session in `waiting_conflict` while the UI moved to `idle`. Every subsequent `sendMessage` hit 409 "Resolve the conflict first", creating ghost messages (Bug 1) on every attempt. The user was silently stuck with no way to continue without refreshing. Fixed by making `sendToHumanReview` async and awaiting `clearConflictInRedis`.

**Bug 3 — "I'll review" button had no loading state**

Because `sendToHumanReview` was synchronous, `handleHumanReview` never set `working = true`. With the async fix above, the modal now shows "Moving to output…" while the Redis clear completes, consistent with how "Fix issues" and "Ship anyway" behave.

---
