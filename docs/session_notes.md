# Session Notes

Current session scratch pad. Reset at start of each session.

---

## 2026-05-29

### Key discoveries
- Next.js version is 16.2.6 (NOT 14). Breaking change: middleware.ts → proxy.ts
- proxy.ts already exists at src/proxy.ts with Clerk middleware setup
- All env vars already configured (.env.local has Clerk, Neon, Redis, Encryption, Sentry keys)
- All npm dependencies already installed
- Clerk v7 sign-in/sign-up pages already exist at src/app/sign-in/ and src/app/sign-up/
- src/app/layout.tsx already has ClerkProvider and basic sign-in/out buttons

### Current session tasks
- [x] Create docs/ memory files
- [x] Create src/types/index.ts
- [x] Create all src/lib/* placeholders
- [x] Create src/store/index.ts
- [x] Create (auth) route group
- [x] Create (dashboard) route group
- [x] Create all API route placeholders
- [x] Update layout.tsx and page.tsx
- [ ] Remove old sign-in/sign-up directories
- [ ] Verify TypeScript compiles clean

### Next session start
- Read docs/current_step.md
- Start STEP 2: Database setup with Drizzle ORM
- Need: CLERK_WEBHOOK_SECRET for Step 3
