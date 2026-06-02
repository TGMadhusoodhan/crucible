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
