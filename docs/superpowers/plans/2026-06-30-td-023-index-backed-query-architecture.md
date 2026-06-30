# TD-023 Index-Backed Query Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make `context feature`, `impact`, and graph-backed health checks consume a shared rebuildable source index while keeping Tenbo memory canonical.

**Architecture:** Add a `sourceIndex` data-layer module with schema, store, freshness, builder, and query helpers. Add a thin `index` CLI command. Refactor consumers incrementally so missing/stale indexes fail open for context/impact and suppress graph-dependent health evidence.

**Tech Stack:** TypeScript, Vitest, ts-morph, Node fs/path/crypto, existing Tenbo dashboard CLI wrapper.

## Global Constraints

- `.tenbo` roadmap/spec/goals/layer docs remain canonical; the source index is derived and disposable.
- V1 is deterministic and lexical/structural; no embeddings, daemon, remote service, large source excerpts, package-script indexing, or rich test relationship indexing.
- Generated index writes must go through an approved Data Layer cache gateway with atomic writes.
- Default index maintenance budget is 3000 ms and must fail open when exceeded.
- Context and impact may use memory/glob fallback with warnings; graph-dependent health findings must not appear authoritative from stale/corrupt/incompatible index evidence.
- Follow TDD: write each behavior test first, verify it fails, then implement.

---

### Task 1: Baseline Dogfood Harness

**Files:**
- Create: `tenbo-dashboard/scripts/dogfood-baseline.test.ts`

**Interfaces:**
- Consumes: `resolveFeatureContext(repoRoot, query)`, `resolveImpact(repoRoot)`, health `collectAll`.
- Produces: executable baseline tests that initially fail on current routing/noise/evidence expectations.

- [x] Write failing tests for:
  - context query `dashboard CLI command impact` recommends `dashboard` + `cli-tools`
  - context query `dashboard data-layer health structural graph dead code coupling` recommends `dashboard` + `data-layer`
  - read plans stay capped at 12 and include at least one `source-file`
  - impact related items are capped at 8 by default
- [x] Run `cd tenbo-dashboard && npm test -- scripts/dogfood-baseline.test.ts --run` and verify failures describe current behavior.
- [x] Keep the test harness deterministic by creating temp Tenbo fixtures instead of depending on this working tree's uncommitted diff where possible.

### Task 2: Source Index Store And Freshness

**Files:**
- Create: `tenbo-dashboard/src/api/lib/sourceIndex/types.ts`
- Create: `tenbo-dashboard/src/api/lib/sourceIndex/store.ts`
- Test: `tenbo-dashboard/src/api/lib/sourceIndex/store.test.ts`
- Modify: `tenbo-dashboard/src/api/lib/tenboFs.ts`

**Interfaces:**
- Produces: `SourceIndex`, `IndexFreshness`, `SOURCE_INDEX_SCHEMA_VERSION`, `readSourceIndex(repoRoot)`, `writeSourceIndex(repoRoot, index)`, `checkSourceIndexFreshness(repoRoot, state?)`.
- Produces: Data Layer generated-cache gateway in `tenboFs.ts`.

- [x] Write failing tests for missing, fresh, stale, corrupt, incompatible, and atomic generated-cache writes.
- [x] Run `cd tenbo-dashboard && npm test -- src/api/lib/sourceIndex/store.test.ts --run` and verify red.
- [x] Implement minimal types and store/freshness behavior.
- [x] Run the store tests and verify green.

### Task 3: Minimal Source Index Builder

**Files:**
- Create: `tenbo-dashboard/src/api/lib/sourceIndex/build.ts`
- Test: `tenbo-dashboard/src/api/lib/sourceIndex/build.test.ts`

**Interfaces:**
- Produces: `buildSourceIndex(repoRoot, state?)`.
- Consumes: `resolveLayerFiles`, `buildStructuralGraph`, Data Layer state.

- [x] Write failing tests for layer ownership, hashes, bounded tokens, imports/imported_by, exports, exported symbols, line counts, and warnings for missing files.
- [x] Run `cd tenbo-dashboard && npm test -- src/api/lib/sourceIndex/build.test.ts --run` and verify red.
- [x] Implement builder using existing layer resolution and structural graph extraction.
- [x] Run builder and store tests and verify green.

### Task 4: Index CLI And Sync Budget

**Files:**
- Create: `tenbo-dashboard/scripts/index.ts`
- Test: `tenbo-dashboard/scripts/index.test.ts`
- Modify: `tenbo-dashboard/scripts/sync.ts`
- Modify: `tenbo-dashboard/bin/tenbo-dashboard.mjs`

**Interfaces:**
- Produces: `tenbo-dashboard index [--json] [--if-stale]`.
- Produces: sync calls `index --if-stale` behavior through shared function with 3000 ms default budget.

- [x] Write failing CLI tests for explicit rebuild, JSON output, `--if-stale`, help exposure, and sync fail-open warning on timeout.
- [x] Run focused script tests and verify red.
- [x] Implement script and wrapper registration.
- [x] Run focused script tests and verify green.

### Task 5: Context Uses Scope-First Index Evidence

**Files:**
- Create: `tenbo-dashboard/src/api/lib/sourceIndex/query.ts`
- Test/modify: `tenbo-dashboard/src/api/lib/contextResolver.test.ts`
- Modify: `tenbo-dashboard/src/api/lib/contextResolver.ts`

**Interfaces:**
- Produces: index-backed evidence scoring helper.
- Changes: `FeatureContextBundle.warnings` includes index freshness warnings; read plan includes source evidence when fresh.

- [x] Write failing tests for the two dogfood routing queries, source evidence in read plan, fallback warning when index missing/stale, and default cap of 12.
- [x] Run context tests and verify red.
- [x] Implement scope-first scoring: select scope from combined scope + item + source evidence, then rank layers inside that scope.
- [x] Run context tests and dogfood baseline tests and verify green.

### Task 6: Impact Uses Indexed Ownership And Ranked Related Items

**Files:**
- Test/modify: `tenbo-dashboard/src/api/lib/impact.test.ts`
- Modify: `tenbo-dashboard/src/api/lib/impact.ts`

**Interfaces:**
- Changes: `ImpactSummary` includes index freshness warnings and capped/ranked related items.

- [x] Write failing tests for indexed ownership mapping, related item cap of 8, explicit stale/missing index warnings, and fallback behavior.
- [x] Run impact tests and verify red.
- [x] Implement ranked related-item scoring using direct changed files, active status, affected layer, and explicit linked specs/files.
- [x] Run impact and dogfood tests and verify green.

### Task 7: Health Uses Shared Graph Evidence

**Files:**
- Test/modify: `tenbo-dashboard/src/api/lib/health/collectAll.test.ts`
- Test/modify: `tenbo-dashboard/src/api/lib/health/coupling.test.ts`
- Test/modify: `tenbo-dashboard/src/api/lib/health/deadCode.test.ts`
- Modify: `tenbo-dashboard/src/api/lib/health/collectAll.ts`
- Modify: `tenbo-dashboard/src/api/lib/health/types.ts`

**Interfaces:**
- Changes: graph-dependent findings include evidence mode when fresh; stale/corrupt/incompatible index suppresses or downgrades graph-dependent findings.

- [x] Write failing tests for fresh index graph evidence and stale/corrupt suppression.
- [x] Run focused health tests and verify red.
- [x] Adapt structural graph use to the shared source index path, keeping compatibility wrappers where useful.
- [x] Run focused health tests and verify green.

### Task 8: Docs, Roadmap Status, And Final Verification

**Files:**
- Modify: `.tenbo/scopes/dashboard/layers/data-layer/intent.md`
- Modify: `.tenbo/scopes/dashboard/layers/data-layer/code-map.md`
- Modify: `.tenbo/scopes/dashboard/layers/cli-tools/code-map.md`
- Modify: `tenbo-dashboard/README.md`
- Modify: `.tenbo/scopes/dashboard/roadmap.yaml`

**Interfaces:**
- Produces: documented source index contract and completed td-023 phases.

- [x] Update Data Layer invariant to describe generated cache gateway.
- [x] Document `tenbo-dashboard index` in CLI/docs.
- [x] Mark td-023 phases done with evidence only after verification passes.
- [x] Run `node tenbo-dashboard/bin/tenbo-dashboard.mjs validate --json`.
- [x] Run `cd tenbo-dashboard && npm test -- --run`.
- [x] Run `cd tenbo-dashboard && npm run build`.
- [x] Run `git diff --check`.
