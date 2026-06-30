# Structural Graph Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen Tenbo health and context workflows with a small generated file/import/layer graph.

**Architecture:** Replace the narrow `ImportGraph` helper with a richer in-memory structural graph that still uses `ts-morph` and existing layer ownership data. Keep the graph generated and disposable; do not introduce a database or query language.

**Tech Stack:** TypeScript, `ts-morph`, existing health analyzers, Vitest.

## Global Constraints

- V1 is TypeScript/TSX only.
- No persistent graph database.
- `.tenbo/` markdown and YAML remain canonical memory.
- Graph facts must be evidence for review, not automatic proof that code should be deleted or moved.

---

### Task 1: Add Structural Graph Data Model

**Files:**
- Create: `tenbo-dashboard/src/api/lib/health/structuralGraph.ts`
- Create: `tenbo-dashboard/src/api/lib/health/structuralGraph.test.ts`
- Modify: `tenbo-dashboard/src/api/lib/health/importGraph.ts`

**Interfaces:**
- Produces: `StructuralGraph`
- Produces: `buildStructuralGraph(repoRoot: string, files: string[], options?: { tsConfigFilePath?: string; layerOfFile?: Map<string, string> }): StructuralGraph`
- Keeps compatibility: `StructuralGraph` has `importsFrom`, `importedBy`, and `allFiles`

- [ ] **Step 1: Write failing tests for graph compatibility**

Create a fixture with `a.ts` importing `b.ts`:

```ts
const graph = buildStructuralGraph(dir, ['src/a.ts', 'src/b.ts']);
expect(graph.importsFrom('src/a.ts')).toEqual(['src/b.ts']);
expect(graph.importedBy('src/b.ts')).toEqual(['src/a.ts']);
expect(graph.allFiles()).toEqual(['src/a.ts', 'src/b.ts']);
```

- [ ] **Step 2: Run failing graph tests**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/health/structuralGraph.test.ts --run`

Expected: FAIL because `structuralGraph.ts` does not exist.

- [ ] **Step 3: Move import graph logic into the new graph builder**

Implement:

```ts
export interface StructuralGraph {
  importsFrom(file: string): string[];
  importedBy(file: string): string[];
  allFiles(): string[];
  layerFor(file: string): string | undefined;
  exportsFrom(file: string): string[];
}
```

Use the existing `ts-morph` import/export declaration walk from `importGraph.ts`.

- [ ] **Step 4: Keep `importGraph.ts` as a compatibility wrapper**

Replace implementation with:

```ts
export type { StructuralGraph as ImportGraph } from './structuralGraph';
export { buildStructuralGraph as buildImportGraph } from './structuralGraph';
export type { BuildStructuralGraphOptions as BuildImportGraphOptions } from './structuralGraph';
```

- [ ] **Step 5: Run compatibility tests**

Run:

```bash
cd tenbo-dashboard
npm test -- src/api/lib/health/importGraph.test.ts src/api/lib/health/structuralGraph.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tenbo-dashboard/src/api/lib/health/structuralGraph.ts tenbo-dashboard/src/api/lib/health/structuralGraph.test.ts tenbo-dashboard/src/api/lib/health/importGraph.ts
git commit -m "refactor: introduce structural graph for health analysis"
```

### Task 2: Add Layer Ownership And Export Evidence

**Files:**
- Modify: `tenbo-dashboard/src/api/lib/health/structuralGraph.ts`
- Modify: `tenbo-dashboard/src/api/lib/health/structuralGraph.test.ts`
- Modify: `tenbo-dashboard/src/api/lib/health/types.ts`

**Interfaces:**
- Consumes: `layerOfFile?: Map<string, string>`
- Produces: `exportsFrom(file): string[]`
- Extends finding details to allow evidence fields where needed

- [ ] **Step 1: Write failing tests for layer and export facts**

```ts
const layerOfFile = new Map([['src/index.ts', 'app']]);
const graph = buildStructuralGraph(dir, ['src/index.ts'], { layerOfFile });
expect(graph.layerFor('src/index.ts')).toBe('app');
expect(graph.exportsFrom('src/index.ts')).toEqual(['runApp']);
```

- [ ] **Step 2: Run failing tests**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/health/structuralGraph.test.ts --run`

Expected: FAIL because `layerFor` and `exportsFrom` are incomplete.

- [ ] **Step 3: Implement layer and export facts**

Collect named export declarations:

```ts
for (const declaration of sf.getExportedDeclarations().keys()) {
  ensure(exported, fromRel).add(declaration);
}
```

Return layer data from the injected `layerOfFile` map.

- [ ] **Step 4: Run graph tests**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/health/structuralGraph.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tenbo-dashboard/src/api/lib/health/structuralGraph.ts tenbo-dashboard/src/api/lib/health/structuralGraph.test.ts tenbo-dashboard/src/api/lib/health/types.ts
git commit -m "feat: add structural graph ownership evidence"
```

### Task 3: Pass Structural Graph Through Health Collection

**Files:**
- Modify: `tenbo-dashboard/src/api/lib/health/collectAll.ts`
- Modify: `tenbo-dashboard/src/api/lib/health/collectAll.test.ts`

**Interfaces:**
- Consumes: `buildStructuralGraph`
- Produces: one graph per scope with `layerOfFile` populated

- [ ] **Step 1: Write failing test for one graph build with ownership**

Spy on the graph builder or assert a coupling finding includes correct layer evidence from graph ownership.

```ts
expect(findings).toContainEqual(expect.objectContaining({
  signal: 'coupling',
  details: expect.objectContaining({ source_layer: 'ui', target_layer: 'data' }),
}));
```

- [ ] **Step 2: Run failing collection tests**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/health/collectAll.test.ts --run`

Expected: FAIL until `collectAll` passes ownership into the graph.

- [ ] **Step 3: Build `layerOfFile` in `collectAll`**

After `filesByLayer`:

```ts
const layerOfFile = new Map<string, string>();
for (const [layerId, files] of Object.entries(filesByLayer)) {
  for (const file of files) layerOfFile.set(file, layerId);
}
```

Call `buildStructuralGraph(repoRoot, allTsFiles, { tsConfigFilePath, layerOfFile })`.

- [ ] **Step 4: Run health tests**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/health/collectAll.test.ts src/api/lib/health/coupling.test.ts src/api/lib/health/deadCode.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tenbo-dashboard/src/api/lib/health/collectAll.ts tenbo-dashboard/src/api/lib/health/collectAll.test.ts
git commit -m "feat: pass structural graph through health analyzers"
```

### Task 4: Add Evidence To Coupling And Dead-Code Findings

**Files:**
- Modify: `tenbo-dashboard/src/api/lib/health/types.ts`
- Modify: `tenbo-dashboard/src/api/lib/health/coupling.ts`
- Modify: `tenbo-dashboard/src/api/lib/health/coupling.test.ts`
- Modify: `tenbo-dashboard/src/api/lib/health/deadCode.ts`
- Modify: `tenbo-dashboard/src/api/lib/health/deadCode.test.ts`

**Interfaces:**
- Produces: coupling details with `source_layer`, `target_layer`, `importer_count`
- Produces: dead-code details with `exported_symbols`

- [ ] **Step 1: Write failing evidence assertions**

```ts
expect(finding.details).toMatchObject({
  kind: 'coupling',
  source_layer: 'ui',
  target_layer: 'data',
  importer_count: 2,
});
```

For dead code:

```ts
expect(finding.details).toMatchObject({
  kind: 'dead-code',
  exported_symbols: ['unusedHelper'],
});
```

- [ ] **Step 2: Run failing analyzer tests**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/health/coupling.test.ts src/api/lib/health/deadCode.test.ts --run`

Expected: FAIL because detail payloads lack these fields.

- [ ] **Step 3: Extend detail types and analyzers**

Update `FindingDetails` variants with the new fields. Fill them from `filesByLayer`, graph ownership, and `graph.exportsFrom(rel)`.

- [ ] **Step 4: Run typecheck and analyzer tests**

Run:

```bash
cd tenbo-dashboard
npm test -- src/api/lib/health/coupling.test.ts src/api/lib/health/deadCode.test.ts src/api/lib/health/types.test.ts --run
npm run build
```

Expected: tests and build pass.

- [ ] **Step 5: Commit**

```bash
git add tenbo-dashboard/src/api/lib/health/types.ts tenbo-dashboard/src/api/lib/health/coupling.ts tenbo-dashboard/src/api/lib/health/coupling.test.ts tenbo-dashboard/src/api/lib/health/deadCode.ts tenbo-dashboard/src/api/lib/health/deadCode.test.ts
git commit -m "feat: attach graph evidence to health findings"
```

### Task 5: Final Verification And Docs

**Files:**
- Modify: `.tenbo/specs/td-020-structural-graph-evidence.md`
- Modify: `tenbo-dashboard/README.md`

**Interfaces:**
- Produces: documentation that graph evidence is generated and not canonical memory

- [ ] **Step 1: Add a short generated-evidence note**

Add to dashboard README health section:

```md
Health findings may include generated graph evidence such as importers,
exports, and layer ownership. This evidence is rebuilt from source and
`.tenbo/` metadata; it is not separate project memory.
```

- [ ] **Step 2: Run final checks**

Run:

```bash
node tenbo-dashboard/bin/tenbo-dashboard.mjs validate --json
cd tenbo-dashboard && npm test -- src/api/lib/health/structuralGraph.test.ts src/api/lib/health/importGraph.test.ts src/api/lib/health/coupling.test.ts src/api/lib/health/deadCode.test.ts src/api/lib/health/collectAll.test.ts --run
cd tenbo-dashboard && npm run build
```

Expected: validation has zero errors; tests pass; build passes.

- [ ] **Step 3: Commit**

```bash
git add tenbo-dashboard/README.md .tenbo/specs/td-020-structural-graph-evidence.md
git commit -m "docs: document generated graph evidence"
```

## Self-Review

- Spec coverage: Covers generated graph, health analyzer evidence, bounded TypeScript scope, and no graph database.
- Placeholder scan: No placeholders remain.
- Type consistency: `StructuralGraph`, `buildStructuralGraph`, and compatibility `ImportGraph` wrapper names are consistent.
