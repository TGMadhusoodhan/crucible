# Current Build Step
Step: PROMPT 10 — GitHub integration
Status: COMPLETE
Started: 2026-07-06
Last Updated: 2026-07-06

## What Is Done In This Step

- `src/lib/workspace/github.ts` — push mechanics with token scrubbing, GitHub REST helpers, git CLI push (token URL as direct arg, never persisted)
- `src/lib/db/schema.ts` — metadata column on api_credentials; githubRepo/githubPushMode/githubBranch on projects
- `drizzle/0003_github_integration.sql` — migration applied on startup
- `src/app/api/credentials/route.ts` — 'github' credential provider; PAT validation via /user endpoint; login name stored in metadata and exposed in GET
- `src/app/api/projects/[id]/route.ts` — PATCH endpoint for GitHub settings (repo validation on link)
- `src/app/api/projects/[id]/push/route.ts` — POST manual push endpoint
- `src/app/api/github/repos/route.ts` — POST create private GitHub repo
- `src/app/api/pipeline/output-gate/accept/route.ts` — push result returned in response
- `src/lib/pipeline/orchestrator.ts` — tryGitHubPush helper; per_file push wired in acceptCurrentFile; per_session push in acceptOutputFile
- `src/types/index.ts` — github_push_success + github_push_failed SSE events
- `src/store/index.ts` — githubPush state; reducer cases
- `src/hooks/usePipeline.ts` — SSE event dispatch
- `src/components/pipeline/CompletePanel.tsx` — push status card (SHA link + branch, or error)
- `src/components/shared/CredentialsManager.tsx` — GitHub PAT section with instructions + login display
- `src/app/(dashboard)/projects/page.tsx` — GitHub tab: repo link, push mode, branch, create repo, manual push button
- `test/unit/github.test.ts` — 6 token scrubbing tests
- tsc: 0 errors. 86/86 tests pass.

## What Remains In This Step

- Nothing

## Blockers

- None

## Next

- PROMPT 11 (TBD)
