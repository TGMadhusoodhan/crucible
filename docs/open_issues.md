# Open Issues

Bugs, blockers, and things to revisit.

---

## ISSUE-001 — Step 3 (Clerk webhook) — deferred to post-deployment
**Status:** Deferred
**Severity:** Non-blocking. Clerk auth (sign-in/sign-up/middleware) already works. Webhook only syncs new users into Neon DB.
**Description:** Step 3 skipped for now. /api/auth/webhook route placeholder exists but is not implemented.
**Resolution:** After deploying to Vercel:
  1. Clerk dashboard → Webhooks → Add Endpoint (use Vercel URL)
  2. Subscribe to user.created event
  3. Copy signing secret → add CLERK_WEBHOOK_SECRET to Vercel env vars
  4. Implement the webhook handler (creates user row in DB)
**Step:** Post-deployment

---

## ISSUE-002 — ENOENT crash on Vercel (server filesystem read-only) — RESOLVED
**Status:** Fixed (2026-06-03)
**Severity:** Critical — blocked all pipeline runs on Vercel.
**Description:** `initProject()` in `filesystem.ts` called `fs.mkdir('~/.crucible/...')` which fails on Vercel's read-only serverless filesystem.
**Resolution:** Added `canWrite()` probe at startup. All write operations (session logs, spec, checkpoints, output) are now best-effort, silently swallowed on read-only filesystems. Pipeline state lives in Redis; filesystem is supplementary only.
**Files changed:** `src/lib/memory/filesystem.ts`

---

## ISSUE-003 — Step-2 "Link local folder" modal blocked project creation cross-platform — RESOLVED
**Status:** Fixed (2026-06-03)
**Description:** After creating a project, a modal forced users to link a local folder. Confusing on mobile/Firefox/Windows/Mac; File System Access API only works on Chrome/Edge desktop.
**Resolution:** Removed step-2 modal. Project creates and auto-selects immediately. Local folder linking is available optionally from the CompletePanel after code is generated (Chrome/Edge only, gracefully disabled elsewhere).
**Files changed:** `src/components/shared/ProjectNavigator.tsx`

---
