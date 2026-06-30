---
tenbo_item: td-023
---

# Index-Backed Query Architecture Design

## Purpose

Move Tenbo from metadata-first query behavior to index-backed query behavior. Tenbo memory remains canonical for product intent, layer boundaries, roadmap state, specs, and decisions. A derived source index becomes the shared evidence layer for context, impact, and health queries.

## Current State

The current implementation has useful pieces, but they are separate:

- `context feature` ranks mainly from Tenbo text, roadmap metadata, and `files_to_read`.
- `impact` maps changed files through layer globs and direct `files_to_read` overlap.
- Health checks build a TypeScript import/export graph on demand.
- `metrics.json`, `parseCache`, and `.file-hashes.json` cache narrow pieces of derived state.

Dogfood validation showed the weakness: read plans are compact, but dashboard CLI/data-layer prompts can over-route to `skill:core-logic`; impact finds affected layers but returns too many related items.

## Recommended Approach

Use a persistent deterministic index, not embeddings-first and not source-only search. The index should be derived from source files plus `.tenbo` ownership metadata, stored as a rebuildable artifact, and queried together with Tenbo memory.

The initial index should be deliberately small: paths, scope/layer ownership, file kind, bounded tokens, imports, imported-by edges, exports, exported symbols, line counts, input hashes, schema version, and generated time. Defer package scripts, rich test relationships, and embeddings until a consumer proves need.

## Boundary Decisions

Generated cache writes still write under `.tenbo/`, so they must respect the Data Layer write boundary. The index store should write through an approved Data Layer cache gateway, preferably in `tenboFs.ts` or a documented sibling helper with atomic-write behavior. It should not perform ad hoc direct writes to arbitrary `.tenbo` paths.

CLI commands stay thin. They invoke Data Layer functions; they do not own index logic.

## Architecture

Add a `sourceIndex` data-layer module with these responsibilities:

- `types`: stable JSON schema.
- `build`: scan scoped files and extract minimal deterministic evidence.
- `store`: atomic read/write through the Data Layer cache gateway.
- `freshness`: compare file hashes, ownership hashes, and schema version.
- `query`: ranked evidence for natural-language requests and changed files.

The intended artifact is `.tenbo/cache/source-index.json`; if implementation changes this, update the spec and boundary docs in the same change.

## Query Algorithm

The resolver should not simply add indexed evidence to the existing global layer scoring. It should:

1. Check index freshness.
2. Query Tenbo memory for goals, layer intent, roadmap, specs, and decisions.
3. Query fresh source index evidence when available.
4. Choose the best scope first.
5. Choose the best layer inside that scope.
6. Emit bounded read plans, verification plans, stale warnings, and source-evidence reasons.

This directly addresses the current failure mode where dashboard prompts can choose the skill layer even when the dashboard scope is stronger.

## Freshness And Failure

Freshness states are `fresh`, `missing`, `stale`, `corrupt`, and `incompatible`.

Command behavior:

- `tenbo-dashboard index --json` performs explicit full rebuild.
- `tenbo-dashboard sync` may run an `index --if-stale` path with a 3000 ms budget.
- `context feature` and `impact` do not run unbounded rebuilds; they use fresh index evidence or fail open with warnings.
- Health findings are stricter: graph-dependent findings must be suppressed or downgraded when index evidence is stale, corrupt, missing, or incompatible.

## Phases

1. Freeze dogfood baselines for context, impact, and health.
2. Define schema, store, freshness, atomic writes, and the Data Layer write contract.
3. Generate the minimal deterministic source index.
4. Refactor `context feature` with scope-first ranking plus source evidence.
5. Refactor `impact` to use indexed ownership and reduce related-item noise.
6. Refactor health checks to reuse shared graph evidence with strict stale-index behavior.
7. Evaluate optional richer fields only after consumers prove need.

## Acceptance Criteria

- Baseline harness exists before consumer rewrites.
- Dashboard CLI prompts set `recommendation.scope` to `dashboard` and top layer to `cli-tools`.
- Dashboard health/data-layer prompts set `recommendation.scope` to `dashboard` and top layer to `data-layer`.
- Read plans stay capped at 12 by default and include source evidence.
- Impact related items are ranked/capped by evidence strength and improve materially from the 33-item noisy baseline.
- Missing, stale, corrupt, and incompatible indexes are explicit in JSON for context, impact, and health.
- Health graph findings cite fresh indexed evidence or state fallback/suppressed mode.
- Index writes are atomic and go through the approved Data Layer cache gateway.
- Default maintenance respects a 3000 ms index budget and fails open when exceeded.
- `validate`, full dashboard tests, and build pass.

## Non-Goals

- No embeddings in v1.
- No daemon or watcher service.
- No remote service dependency.
- No source index as canonical hand-edited memory.
- No replacement of Tenbo goals, roadmap, specs, decisions, or layer docs.
- No package-script or rich test relationship indexing until a consumer proves need.

## Risks

- The index could become a second source of truth. Keep it generated, versioned, and disposable.
- Ranking could overfit source tokens. Blend index evidence with Tenbo memory and goals.
- Scope/layer ranking could remain wrong if the resolver keeps global layer scoring. Make scope-first ranking a test contract.
- Rebuilds could become slow. Start deterministic, scoped, and budgeted before adding complexity.
- Stale index warnings could be ignored. Surface freshness in every JSON consumer and suppress authoritative health findings when graph evidence is stale.
