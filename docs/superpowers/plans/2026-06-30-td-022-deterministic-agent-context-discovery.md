# Deterministic Agent Context Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `tenbo context feature --json` return an ordered read and verification plan for fresh agents.

**Architecture:** Extend the existing `contextResolver.ts` output instead of adding a new subsystem. Keep scoring in one resolver, then layer a bounded read-plan builder over the existing recommendation, roadmap, and file-list data.

**Tech Stack:** TypeScript, Vitest, Node CLI via `node --import ./node_modules/tsx/dist/loader.mjs`, existing `tenbo-dashboard` command router.

## Global Constraints

- Preserve current `FeatureContextBundle` fields for backwards compatibility.
- Keep output bounded and machine-readable; no generated prose dumps.
- Do not add LLM calls or external dependencies.
- Update skill guidance in the same change as the CLI contract.

---

### Task 1: Add Read-Plan Types And Resolver Tests

**Files:**
- Modify: `tenbo-dashboard/src/api/lib/contextResolver.ts`
- Modify: `tenbo-dashboard/src/api/lib/contextResolver.test.ts`

**Interfaces:**
- Produces: `ContextReadPlanEntry` with `{ path: string; kind: ContextReadPlanKind; reason: string; priority: number }`
- Produces: `ContextVerificationEntry` with `{ command: string; purpose: string; when: string }`
- Produces: `FeatureContextBundle.context.read_plan` and `FeatureContextBundle.context.verification_plan`

- [ ] **Step 1: Write failing tests for ordered context output**

Add assertions to the existing feature-context test fixture:

```ts
expect(bundle.context.read_plan).toEqual([
  expect.objectContaining({
    path: '.tenbo/overview.md',
    kind: 'product',
    reason: expect.stringContaining('goals'),
    priority: 1,
  }),
  expect.objectContaining({
    path: '.tenbo/scopes/editor/layers/app/intent.md',
    kind: 'layer-intent',
  }),
]);
expect(bundle.context.verification_plan).toContainEqual({
  command: 'node tenbo-dashboard/bin/tenbo-dashboard.mjs validate --json',
  purpose: 'Check Tenbo roadmap and documentation structure',
  when: 'after changing .tenbo files',
});
```

- [ ] **Step 2: Run the failing resolver test**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/contextResolver.test.ts --run`

Expected: FAIL because `read_plan` and `verification_plan` do not exist.

- [ ] **Step 3: Add exported types and bundle fields**

Add the fields to `contextResolver.ts`:

```ts
export type ContextReadPlanKind =
  | 'product'
  | 'layer-intent'
  | 'layer-code-map'
  | 'roadmap-item'
  | 'source-file'
  | 'spec';

export interface ContextReadPlanEntry {
  path: string;
  kind: ContextReadPlanKind;
  reason: string;
  priority: number;
}

export interface ContextVerificationEntry {
  command: string;
  purpose: string;
  when: string;
}
```

Extend `FeatureContextBundle.context`:

```ts
context: {
  layer_docs: string[];
  files_to_read: string[];
  read_plan: ContextReadPlanEntry[];
  verification_plan: ContextVerificationEntry[];
};
```

- [ ] **Step 4: Run the test and confirm the type failure is now about values**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/contextResolver.test.ts --run`

Expected: FAIL because resolver output has empty or missing plan arrays.

- [ ] **Step 5: Commit**

```bash
git add tenbo-dashboard/src/api/lib/contextResolver.ts tenbo-dashboard/src/api/lib/contextResolver.test.ts
git commit -m "test: define context read plan contract"
```

### Task 2: Build The Read Plan

**Files:**
- Modify: `tenbo-dashboard/src/api/lib/contextResolver.ts`
- Modify: `tenbo-dashboard/src/api/lib/contextResolver.test.ts`

**Interfaces:**
- Consumes: `ContextReadPlanEntry`
- Produces: `buildReadPlan(args): ContextReadPlanEntry[]`

- [ ] **Step 1: Add failing tests for bounds and de-duplication**

Add cases that assert `.tenbo/overview.md` appears once, matching item files appear after layer docs, and the result length is no more than 12:

```ts
expect(bundle.context.read_plan.filter((entry) => entry.path === '.tenbo/overview.md')).toHaveLength(1);
expect(bundle.context.read_plan.length).toBeLessThanOrEqual(12);
expect(bundle.context.read_plan.map((entry) => entry.path)).toContain('src/app.ts');
```

- [ ] **Step 2: Run the failing test**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/contextResolver.test.ts --run`

Expected: FAIL because read-plan assembly is not implemented.

- [ ] **Step 3: Implement the small read-plan builder**

Add a helper near the existing `unique` helper:

```ts
function pushReadPlan(
  entries: ContextReadPlanEntry[],
  seen: Set<string>,
  entry: ContextReadPlanEntry,
) {
  if (seen.has(entry.path)) return;
  seen.add(entry.path);
  entries.push(entry);
}
```

Add a builder that starts with product context, then layer docs, then matching item links/files:

```ts
function buildReadPlan(args: {
  selectedScope: Scope | null;
  selectedLayers: string[];
  layerDocs: string[];
  activeItems: ScoredItemEntry[];
  matchingItems: ScoredItemEntry[];
  filesToRead: string[];
}): ContextReadPlanEntry[] {
  const entries: ContextReadPlanEntry[] = [];
  const seen = new Set<string>();
  pushReadPlan(entries, seen, {
    path: '.tenbo/overview.md',
    kind: 'product',
    reason: 'Product goals and non-goals frame the request',
    priority: 1,
  });
  for (const doc of args.layerDocs) {
    pushReadPlan(entries, seen, {
      path: doc,
      kind: doc.endsWith('/intent.md') ? 'layer-intent' : 'layer-code-map',
      reason: 'Selected layer context for the request',
      priority: entries.length + 1,
    });
  }
  for (const entry of [...args.activeItems, ...args.matchingItems]) {
    for (const link of entry.item.links ?? []) {
      pushReadPlan(entries, seen, {
        path: link,
        kind: 'spec',
        reason: `Linked plan/spec for ${entry.item.id}`,
        priority: entries.length + 1,
      });
    }
  }
  for (const file of args.filesToRead) {
    pushReadPlan(entries, seen, {
      path: file,
      kind: file.startsWith('.tenbo/') ? 'roadmap-item' : 'source-file',
      reason: 'Referenced by active or matching roadmap context',
      priority: entries.length + 1,
    });
  }
  return entries.slice(0, 12).map((entry, index) => ({ ...entry, priority: index + 1 }));
}
```

- [ ] **Step 4: Wire `buildReadPlan` into `resolveFeatureContext`**

Set:

```ts
const readPlan = buildReadPlan({
  selectedScope,
  selectedLayers,
  layerDocs,
  activeItems,
  matchingItems,
  filesToRead,
});
```

Return it under `context.read_plan`.

- [ ] **Step 5: Run the resolver tests**

Run: `cd tenbo-dashboard && npm test -- src/api/lib/contextResolver.test.ts --run`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tenbo-dashboard/src/api/lib/contextResolver.ts tenbo-dashboard/src/api/lib/contextResolver.test.ts
git commit -m "feat: add deterministic context read plan"
```

### Task 3: Add Verification Plan And CLI Coverage

**Files:**
- Modify: `tenbo-dashboard/src/api/lib/contextResolver.ts`
- Modify: `tenbo-dashboard/scripts/context.test.ts`

**Interfaces:**
- Consumes: `ContextVerificationEntry`
- Produces: `buildVerificationPlan(): ContextVerificationEntry[]`

- [ ] **Step 1: Write failing CLI output test**

In `context.test.ts`, assert JSON includes stable commands:

```ts
expect(payload.context.verification_plan).toEqual([
  {
    command: 'node tenbo-dashboard/bin/tenbo-dashboard.mjs validate --json',
    purpose: 'Check Tenbo roadmap and documentation structure',
    when: 'after changing .tenbo files',
  },
  {
    command: 'cd tenbo-dashboard && npm test -- --run',
    purpose: 'Run dashboard and CLI unit tests',
    when: 'after changing dashboard code',
  },
]);
```

- [ ] **Step 2: Run the failing CLI test**

Run: `cd tenbo-dashboard && npm test -- scripts/context.test.ts --run`

Expected: FAIL until verification plan is returned.

- [ ] **Step 3: Implement verification plan**

Add:

```ts
function buildVerificationPlan(): ContextVerificationEntry[] {
  return [
    {
      command: 'node tenbo-dashboard/bin/tenbo-dashboard.mjs validate --json',
      purpose: 'Check Tenbo roadmap and documentation structure',
      when: 'after changing .tenbo files',
    },
    {
      command: 'cd tenbo-dashboard && npm test -- --run',
      purpose: 'Run dashboard and CLI unit tests',
      when: 'after changing dashboard code',
    },
  ];
}
```

Return `verification_plan: buildVerificationPlan()`.

- [ ] **Step 4: Run focused tests**

Run:

```bash
cd tenbo-dashboard
npm test -- src/api/lib/contextResolver.test.ts scripts/context.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tenbo-dashboard/src/api/lib/contextResolver.ts tenbo-dashboard/scripts/context.test.ts
git commit -m "feat: include context verification plan"
```

### Task 4: Update Skill Guidance And Final Verification

**Files:**
- Modify: `skill/SKILL.md`
- Modify: `cursor/tenbo.mdc`

**Interfaces:**
- Consumes: `tenbo-dashboard context feature --query "<request>" --json`
- Produces: skill guidance that says agents should follow `context.read_plan` before broad search

- [ ] **Step 1: Patch the context fast-path instruction**

In both skill surfaces, update the existing automatic context fetch guidance with:

```md
Use `context.read_plan` as the ordered first-read list. Read entries in ascending
`priority` before broad source search unless the request names a specific file.
Use `context.verification_plan` to choose the smallest relevant post-change checks.
```

- [ ] **Step 2: Run validation and tests**

Run:

```bash
node tenbo-dashboard/bin/tenbo-dashboard.mjs validate --json
cd tenbo-dashboard && npm test -- src/api/lib/contextResolver.test.ts scripts/context.test.ts --run
cd tenbo-dashboard && npm run build
```

Expected: validation has zero errors; focused tests pass; build passes.

- [ ] **Step 3: Commit**

```bash
git add skill/SKILL.md cursor/tenbo.mdc tenbo-dashboard/src/api/lib/contextResolver.ts tenbo-dashboard/src/api/lib/contextResolver.test.ts tenbo-dashboard/scripts/context.test.ts
git commit -m "docs: teach agents to follow context read plans"
```

## Self-Review

- Spec coverage: Covers ordered read plan, stable JSON shape, freshness/verification guidance, skill docs, and bounded output.
- Placeholder scan: No placeholders remain.
- Type consistency: `ContextReadPlanEntry`, `ContextVerificationEntry`, and `FeatureContextBundle.context` names are used consistently across tasks.
