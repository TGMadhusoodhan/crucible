# Current Build Step
Step: PROMPT 7 — Workspace mode
Status: COMPLETE
Started: 2026-07-06
Last Updated: 2026-07-06

## What Is Done In This Step

- `drizzle/0002_workspace_dir.sql` — ALTER TABLE adds `workspace_dir TEXT` (nullable) to projects
- `drizzle/meta/_journal.json` — migration entry added; auto-migrates on next server start
- `src/lib/db/schema.ts` — `workspaceDir` text column added to projects table
- `src/lib/workspace/paths.ts` — `resolveInWorkspace(workspaceDir, relPath)` rejects null bytes and path traversal (both `..` and absolute paths); every write/read goes through it
- `src/lib/workspace/index.ts` — `prepareWorkspaceForSession`, `writeAcceptedFile`, `readWorkspaceFile`, `listWorkspaceFiles`, `getFileCommitHash`; git integration via execFile (no new deps); git failure is non-fatal (warns and continues)
- `src/types/index.ts` — `workspaceDir?: string | null` added to `PipelineSessionState`
- `src/lib/pipeline/orchestrator.ts` — `StartPipelineParams.workspaceDir`; `createSession` stores it in state; `acceptCurrentFile` calls `writeAcceptedFile` if workspace set; `applyOutputFix` writes to workspace too
- `src/app/api/pipeline/start/route.ts` — loads `workspaceDir` from DB; calls `prepareWorkspaceForSession` before session; passes to `createSession`
- `src/app/api/projects/route.ts` — POST accepts optional `workspaceDir`
- `src/app/api/files/[projectId]/route.ts` — returns `workspaceDir` + per-file `inWorkspace: boolean`
- `src/app/api/files/[projectId]/[...filepath]/route.ts` — GET returns `commitHash` + `workspacePath`
- `src/components/files/FilesSection.tsx` — workspace dir shown in tree header; per-file ✓ badge when written to workspace; file header shows real absolute path + commit hash
- tsc: 0 errors; 58/58 tests pass; committed `7b98c41`

## What Remains In This Step

- UI for picking/linking workspace during project creation (no spec'd yet — deferred)

## Blockers

- None

## Next

- PROMPT 8 (TBD)
