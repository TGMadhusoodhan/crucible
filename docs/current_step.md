# Current Build Step
Step: PROMPT 9 — Interface index
Status: COMPLETE
Started: 2026-07-06
Last Updated: 2026-07-06

## What Is Done In This Step

- `src/lib/workspace/indexer.ts` — TypeScript compiler API (syntactic, no type-checker); extracts function signatures, interfaces (full text), type aliases, class public-method signatures, enums, const/let exports, re-exports; `buildSignatureBlock(filename, code)` + `indexWorkspaceFiles(dir, registry, driftedFiles)` for incremental backfill
- `src/lib/pipeline/context-builder.ts` — three-tier context builder: T1 direct deps full source (12k token cap, demotion), T2 other known files signature blocks (6k cap, omit largest-first), T3 pending files one-line purposes; `buildGenerationContext()` + `buildReviewerDepContext()`
- `src/types/index.ts` — `signatureBlock?: string` on `RegistryEntry`; `registry?: RegistryEntry[]` on `ModelAdapter.generate()` and `ModelAdapter.reviewAndPatch()`
- `src/lib/workspace/memory.ts` — exported `writeRegistry` (was private)
- `src/lib/adapters/base.ts` — `generate()` replaced hand-rolled depContext with context-builder tiers; `reviewAndPatch()` injects direct-dep signature blocks into round-1 reviewer prompt for cross-file contract violation detection
- `src/lib/pipeline/phase3-generate.ts` — `registry?` param threaded to `coderAdapter.generate()`
- `src/lib/pipeline/phase3-review.ts` — `registry?` param threaded to both `r1Adapter.reviewAndPatch()` and `r2Adapter.reviewAndPatch()`
- `src/lib/pipeline/orchestrator.ts` — imports indexer; calls `indexWorkspaceFiles` + `writeRegistry` in `createSession` to backfill signature blocks; loads `sessionRegistry` once before phase3 loop; passes to `runPhase3Generate` and `runPhase3Review`; `acceptCurrentFile` stores `signatureBlock: buildSignatureBlock(fname, code)` in registry
- `test/unit/indexer.test.ts` — 22 tests across 6 describe blocks: functions/consts, interfaces/types, classes, default exports/overloads, re-exports, non-TS fallback
- tsc: 0 errors; 80/80 tests pass

## What Remains In This Step

- Nothing

## Blockers

- None

## Next

- PROMPT 10 (TBD)
