# Diff Impact Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `tenbo impact --since <ref> --json` command that maps git changes to Tenbo layers, docs, roadmap items, and checks.

**Architecture:** Build a small data-layer function for impact analysis, then expose it through a CLI script and top-level command. Keep git collection isolated from Tenbo mapping so it can be tested with temporary repositories.

**Tech Stack:** TypeScript, Node `child_process.execFileSync`, Vitest temp git repos, existing Tenbo filesystem and CLI helpers.

## Global Constraints

- Read-only command; no status flips, doc writes, or git writes.
- Include staged, unstaged, untracked, and committed changes.
- Avoid shell string interpolation for user-supplied refs.
- Keep JSON compact and stable.

---

### Task 1: Implement Safe Git Changed-File Collection

**Files:**
- Create: `tenbo-dashboard/src/api/lib/impact.ts`
- Create: `tenbo-dashboard/src/api/lib/impact.test.ts`

**Interfaces:**
- Produces: `collectChangedFiles(repoRoot: string, options?: { since?: string }): ImpactGitSummary`
- Produces: `ImpactGitSummary` with `{ compared_ref?: string; changed_files: string[]; sources: string[]; warnings: string[] }`

- [ ] **Step 1: Write failing tests with a temp git repo**

Create tests that initialize a repo, commit one file, modify another, stage one, and create one untracked file:

```ts
const summary = collectChangedFiles(dir);
expect(summary.changed_files).toEqual(['src/new.ts', 'src/staged.ts', 'src/unstaged.ts']);
expect(summary.sources).toEqual(expect.arrayContaining(['worktree', 'status']));
```

Add a `since: 'HEAD~1'` test after making a second commit:

```ts
const summary = collectChangedFiles(dir, { since: 'HEAD~1' });
expect(summary.compared_ref).toBe('HEAD~1');
expect(summary.changed_files).toContain('src/committed.ts');
```

- [ ] **Step 2: Run the failing impact tests**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/impact.test.ts --run`

Expected: FAIL because `impact.ts` does not exist.

- [ ] **Step 3: Implement `collectChangedFiles` with `execFileSync`**

Use `git -C <repoRoot> diff --name-only`, `git diff --name-only --cached`, `git status --porcelain --untracked-files=normal`, and optionally `git diff --name-only <since>...HEAD`.

Core helper:

```ts
function gitLines(repoRoot: string, args: string[]): string[] {
  const out = execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
```

Parse porcelain rows by stripping the two-character status and keeping rename destinations after ` -> `.

- [ ] **Step 4: Run the tests**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/impact.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tenbo-dashboard/src/api/lib/impact.ts tenbo-dashboard/src/api/lib/impact.test.ts
git commit -m "feat: collect changed files for impact context"
```

### Task 2: Map Changed Files To Tenbo Layers And Docs

**Files:**
- Modify: `tenbo-dashboard/src/api/lib/impact.ts`
- Modify: `tenbo-dashboard/src/api/lib/impact.test.ts`

**Interfaces:**
- Produces: `resolveImpact(repoRoot: string, options?: { since?: string }): ImpactSummary`
- `ImpactSummary` includes `{ changed_files, affected_layers, stale_docs, uncovered_files, recommended_checks }`

- [ ] **Step 1: Write failing mapping tests**

Use a fixture `.tenbo/workspace.yaml`, scope architecture, and layer docs. Assert a changed file maps to a layer and an unmatched file appears under `uncovered_files`:

```ts
const impact = resolveImpact(dir);
expect(impact.affected_layers).toEqual([
  expect.objectContaining({ scope: 'editor', layer: 'app', changed_files: ['apps/editor/src/app.ts'] }),
]);
expect(impact.uncovered_files).toEqual(['scripts/migrate.ts']);
```

- [ ] **Step 2: Run failing mapping tests**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/impact.test.ts --run`

Expected: FAIL because `resolveImpact` is not implemented.

- [ ] **Step 3: Implement Tenbo mapping**

Read state with `readState(repoRoot)` and reuse `resolveLayerFiles(repoRoot, scope)`. For each changed file, match it against the resolved files per layer. Add stale docs for affected layers:

```ts
const staleDocs = affectedLayers.flatMap((entry) => [
  `.tenbo/scopes/${entry.scope}/layers/${entry.layer}/code-map.md`,
]);
```

Add default checks:

```ts
recommended_checks: [
  'node tenbo-dashboard/bin/tenbo-dashboard.mjs validate --json',
  'cd tenbo-dashboard && npm test -- --run',
]
```

- [ ] **Step 4: Run mapping tests**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/impact.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tenbo-dashboard/src/api/lib/impact.ts tenbo-dashboard/src/api/lib/impact.test.ts
git commit -m "feat: map changed files to tenbo layers"
```

### Task 3: Relate Impact To Roadmap Items

**Files:**
- Modify: `tenbo-dashboard/src/api/lib/impact.ts`
- Modify: `tenbo-dashboard/src/api/lib/impact.test.ts`

**Interfaces:**
- Produces: `related_items: Array<{ id: string; scope: string; title: string; reason: string }>`

- [ ] **Step 1: Write failing related-item tests**

Create roadmap items with `status: now`, matching `layer`, and `files_to_read`. Assert both layer and explicit-file matches are returned:

```ts
expect(impact.related_items).toEqual([
  expect.objectContaining({ id: 'ed-001', reason: expect.stringContaining('active item') }),
  expect.objectContaining({ id: 'ed-002', reason: expect.stringContaining('files_to_read') }),
]);
```

- [ ] **Step 2: Run failing tests**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/impact.test.ts --run`

Expected: FAIL because `related_items` is empty or missing.

- [ ] **Step 3: Implement item matching**

For each item in each scope:

```ts
const itemLayerRefs = [item.layer, ...(item.layers ?? []), ...(item.affects ?? [])].filter(Boolean);
const fileRefs = new Set(item.files_to_read ?? []);
```

Match if the item is `now`, if its layer is affected, or if any changed file appears in `files_to_read`. Keep reasons short and deterministic.

- [ ] **Step 4: Run tests**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/impact.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tenbo-dashboard/src/api/lib/impact.ts tenbo-dashboard/src/api/lib/impact.test.ts
git commit -m "feat: connect impact output to roadmap items"
```

### Task 4: Expose `tenbo impact`

**Files:**
- Create: `tenbo-dashboard/scripts/impact.ts`
- Create: `tenbo-dashboard/scripts/impact.test.ts`
- Modify: `tenbo-dashboard/bin/tenbo-dashboard.mjs`

**Interfaces:**
- Consumes: `resolveImpact(repoRoot, { since })`
- Produces: CLI `tenbo-dashboard impact [--since <ref>] [--json]`

- [ ] **Step 1: Write failing CLI tests**

Assert JSON output and misuse:

```ts
const result = runImpactCli(dir, ['--json']);
expect(result.exitCode).toBe(0);
expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });

const bad = runImpactCli(dir, ['--since']);
expect(bad.exitCode).toBe(2);
```

- [ ] **Step 2: Run failing CLI tests**

Run: `cd tenbo-dashboard && npm test -- scripts/impact.test.ts --run`

Expected: FAIL because `impact.ts` does not exist.

- [ ] **Step 3: Implement script and command router entry**

Add:

```ts
export function runImpactCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const since = readOption(args, '--since');
  if (args.includes('--since') && !since) return misuse('Usage: tenbo impact [--since <ref>] [--json]', json);
  const payload = resolveImpact(repoRoot, { since });
  return serialize(payload, json, `${payload.changed_files.length} changed file(s), ${payload.affected_layers.length} affected layer(s)\n`);
}
```

Register `'impact': 'scripts/impact.ts'` in `bin/tenbo-dashboard.mjs` and add one help line.

- [ ] **Step 4: Run focused tests and help smoke check**

Run:

```bash
cd tenbo-dashboard
npm test -- src/api/lib/impact.test.ts scripts/impact.test.ts --run
node bin/tenbo-dashboard.mjs help | rg "impact"
```

Expected: tests pass; help mentions impact.

- [ ] **Step 5: Commit**

```bash
git add tenbo-dashboard/src/api/lib/impact.ts tenbo-dashboard/src/api/lib/impact.test.ts tenbo-dashboard/scripts/impact.ts tenbo-dashboard/scripts/impact.test.ts tenbo-dashboard/bin/tenbo-dashboard.mjs
git commit -m "feat: add impact context command"
```

### Task 5: Wire Skill Guidance And Final Verification

**Files:**
- Modify: `skill/references/completion-sync.md`
- Modify: `skill/SKILL.md`
- Modify: `cursor/tenbo-completion-sync.mdc`
- Modify: `cursor/tenbo.mdc`

**Interfaces:**
- Consumes: `tenbo-dashboard impact --json`
- Produces: completion guidance that uses impact before deciding docs/status freshness

- [ ] **Step 1: Add completion guidance**

Patch completion flow with:

```md
Before final status/doc decisions after agent-authored code, run:
`npx tenbo-dashboard impact --json`
Use affected layers and stale_docs as the checklist for doc_update and micro-sync.
The command is advisory; do not auto-flip roadmap status from impact output alone.
```

- [ ] **Step 2: Run full verification**

Run:

```bash
node tenbo-dashboard/bin/tenbo-dashboard.mjs validate --json
cd tenbo-dashboard && npm test -- src/api/lib/impact.test.ts scripts/impact.test.ts --run
cd tenbo-dashboard && npm run build
```

Expected: validation has zero errors; tests pass; build passes.

- [ ] **Step 3: Commit**

```bash
git add skill/SKILL.md skill/references/completion-sync.md cursor/tenbo.mdc cursor/tenbo-completion-sync.mdc
git commit -m "docs: use impact context during completion"
```

## Self-Review

- Spec coverage: Covers changed-file collection, layer/doc mapping, related roadmap items, CLI exposure, and completion integration.
- Placeholder scan: No placeholders remain.
- Type consistency: `ImpactGitSummary`, `ImpactSummary`, `resolveImpact`, and `runImpactCli` are consistently named.
