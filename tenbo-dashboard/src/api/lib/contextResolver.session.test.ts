import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readState } from './tenboFs';
import { validate } from './validator';
import { resolveSessionContext } from './contextResolver';
import { buildSourceIndex } from './sourceIndex/build';
import { writeSourceIndex } from './sourceIndex/store';
import { buildStructuralBlock, upsertMarkedRegion } from './codeMapGenerator';

let dir: string;
const NOW = new Date('2026-06-20T12:00:00.000Z');

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-context-session-'));
  mkdirSync(path.join(dir, '.git'));
  mkdirSync(path.join(dir, '.tenbo/scopes/dashboard/layers/cli-tools'), { recursive: true });
  mkdirSync(path.join(dir, '.tenbo/workpads'), { recursive: true });

  writeFileSync(path.join(dir, '.tenbo/workspace.yaml'), [
    'scopes:',
    '  - id: dashboard',
    '    path: tenbo-dashboard',
    '    description: dashboard and CLI package',
    'cross_cutting: []',
    '',
  ].join('\n'));

  writeFileSync(path.join(dir, '.tenbo/overview.md'), [
    '# Overview',
    '',
    '## Product goals',
    '- **g1**: Give agents holistic context.',
    '',
  ].join('\n'));

  // Custom thresholds — stale_now_days: 3, stale_next_days: 10 — to prove
  // resolveSessionContext reads them instead of using the hardcoded defaults.
  writeFileSync(path.join(dir, '.tenbo/principles.md'), [
    '# Principles',
    '',
    '## Metric thresholds',
    '',
    '```yaml',
    'stale_now_days: 3',
    'stale_next_days: 10',
    '```',
    '',
  ].join('\n'));

  writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/architecture.yaml'), [
    'layers:',
    '  - id: cli-tools',
    '    name: CLI Tools',
    '    description: Commands for agents to fetch context.',
    '    files: ["bin/**", "scripts/**"]',
    '',
  ].join('\n'));
  writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/layers/cli-tools/intent.md'), '# CLI Tools\n');

  writeFileSync(path.join(dir, '.tenbo/workpads/td-105.md'), [
    '---',
    'item: td-105',
    'opened: 2026-06-15',
    'last_updated: 2026-06-19',
    'env: main@abc1234',
    '---',
    '',
    '## Plan',
    '',
    '- [x] 1. did the first thing',
    '- [ ] 2. still need to do this',
    '- [ ] 3. and this',
    '',
    '## Acceptance Criteria',
    '',
    '- [ ] matches done_when',
    '',
  ].join('\n'));

  writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/roadmap.yaml'), [
    'items:',
    '  - id: td-101',
    '    title: Stale now item',
    '    layer: cli-tools',
    '    status: now',
    '    description: Has not been touched in a while.',
    '    notes: "2026-06-10: started work."',
    '  - id: td-102',
    '    title: Fresh now item',
    '    layer: cli-tools',
    '    status: now',
    '    description: Touched recently.',
    '    notes: "2026-06-19: still going."',
    '  - id: td-103',
    '    title: Now item with no activity evidence',
    '    layer: cli-tools',
    '    status: now',
    '    description: No notes or workpad.',
    '  - id: td-104',
    '    title: Stale next item',
    '    layer: cli-tools',
    '    status: next',
    '    description: Queued a long time ago.',
    '    notes: "2026-05-01: captured."',
    '  - id: td-105',
    '    title: Item with an in-progress workpad',
    '    layer: cli-tools',
    '    status: now',
    '    description: Has a workpad with unchecked plan items.',
    '    workpad: .tenbo/workpads/td-105.md',
    '',
  ].join('\n'));

  writeFileSync(path.join(dir, '.tenbo/.pending-reconciliation.yaml'), [
    'items:',
    '  - opened_at: 2026-06-01',
    '    layer: cli-tools',
    '    kind: intent_drift',
    '    description: something to review',
    '    source_commit: abc123',
    '  - opened_at: 2026-06-02',
    '    layer: cli-tools',
    '    kind: boundary_decision',
    '    description: another thing',
    '    source_commit: def456',
    '',
  ].join('\n'));

  writeFileSync(path.join(dir, '.tenbo/observations.md'), [
    '# Observations',
    '',
    '- 2026-01-01: an old observation nobody cares about anymore.',
    '- 2026-06-18: a recent observation worth surfacing.',
    '- 2026-06-19: another recent observation.',
    '',
  ].join('\n'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveSessionContext', () => {
  it('builds a bounded session briefing bundle with stale/workpad/reconciliation/observation sections', () => {
    const bundle = resolveSessionContext(dir, { now: NOW });

    expect(bundle.ok).toBe(true);
    expect(bundle.intent).toBe('session');

    // now items: all 4 now-status items counted, titles + days_active surfaced.
    expect(bundle.now.count).toBe(4);
    expect(bundle.now.items.map((entry) => entry.id).sort()).toEqual(['td-101', 'td-102', 'td-103', 'td-105']);
    const td101 = bundle.now.items.find((entry) => entry.id === 'td-101');
    expect(td101?.days_active).toBe(10);
    const td103 = bundle.now.items.find((entry) => entry.id === 'td-103');
    expect(td103?.days_active).toBeNull();

    // stale now: only td-101 exceeds stale_now_days (3).
    expect(bundle.stale.now.map((entry) => entry.id)).toEqual(['td-101']);
    expect(bundle.stale.now[0]).toMatchObject({ days_active: 10, threshold_days: 3 });

    // stale next: td-104 exceeds stale_next_days (10).
    expect(bundle.stale.next.map((entry) => entry.id)).toEqual(['td-104']);
    expect(bundle.stale.next[0].threshold_days).toBe(10);

    // pending reconciliation: 2 distinct entries, with a bounded per-entry {layer, kind}
    // breakdown (td-036) sorted by layer then kind then opened_at.
    expect(bundle.pending_reconciliation).toEqual({
      count: 2,
      path: '.tenbo/.pending-reconciliation.yaml',
      entries: [
        { layer: 'cli-tools', kind: 'boundary_decision' },
        { layer: 'cli-tools', kind: 'intent_drift' },
      ],
    });

    // workpad resume: td-105 has an in-progress workpad with 2 unchecked plan items.
    expect(bundle.workpad_resume).toEqual([
      {
        item_id: 'td-105',
        scope: 'dashboard',
        title: 'Item with an in-progress workpad',
        workpad: '.tenbo/workpads/td-105.md',
        unchecked_plan_items: 2,
      },
    ]);

    // recent observations: prefers entries dated within the last 7 days.
    expect(bundle.recent_observations).toEqual([
      '- 2026-06-18: a recent observation worth surfacing.',
      '- 2026-06-19: another recent observation.',
    ]);

    // validation delta: no prior snapshot committed to this fixture — omitted (fail open).
    expect(bundle.validation_delta).toBeUndefined();

    // agent-context.md is absent from this fixture — fails open with a warning.
    expect(bundle.warnings).toContainEqual(expect.objectContaining({ kind: 'missing_agent_context' }));
  });

  it('computes a validation delta against a prior .validation-status.json snapshot', () => {
    const state = readState(dir);
    const result = validate(state);
    writeFileSync(path.join(dir, '.tenbo/.validation-status.json'), JSON.stringify({
      generated_at: '2026-06-19T00:00:00.000Z',
      errors: [],
      warnings: [],
    }));

    const bundle = resolveSessionContext(dir, { now: NOW });

    expect(bundle.validation_delta).toEqual({
      generated_at: '2026-06-19T00:00:00.000Z',
      previous_errors: 0,
      previous_warnings: 0,
      current_errors: result.errors.length,
      current_warnings: result.warnings.length,
      new_errors: result.errors.length,
      new_warnings: result.warnings.length,
    });
  });

  it('omits optional sections entirely when their source files are absent', () => {
    rmSync(path.join(dir, '.tenbo/.pending-reconciliation.yaml'));
    rmSync(path.join(dir, '.tenbo/observations.md'));
    writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/roadmap.yaml'), [
      'items:',
      '  - id: td-201',
      '    title: Solo item',
      '    layer: cli-tools',
      '    status: later',
      '    description: nothing in progress',
      '',
    ].join('\n'));

    const bundle = resolveSessionContext(dir, { now: NOW });

    expect(bundle.now).toEqual({ count: 0, items: [] });
    expect(bundle.stale).toEqual({ now: [], next: [] });
    // pending_reconciliation is always present (like doc_staleness) — fail-open to
    // count 0 + empty entries rather than omitted, when the ledger file is absent.
    expect(bundle.pending_reconciliation).toEqual({
      count: 0,
      path: '.tenbo/.pending-reconciliation.yaml',
      entries: [],
    });
    expect(bundle.workpad_resume).toBeUndefined();
    expect(bundle.recent_observations).toBeUndefined();
  });

  it('caps now.items and stale.now at SESSION_LIST_CAP (12) when more items qualify', () => {
    // 15 `now` items, all stale (notes dated well beyond stale_now_days: 3).
    const items = Array.from({ length: 15 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0');
      return [
        `  - id: td-2${n}`,
        `    title: Overflow now item ${n}`,
        '    layer: cli-tools',
        '    status: now',
        `    description: Overflow fixture item ${n}.`,
        '    notes: "2026-06-01: started, then abandoned."',
      ].join('\n');
    }).join('\n');
    writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/roadmap.yaml'), `items:\n${items}\n`);

    const bundle = resolveSessionContext(dir, { now: NOW });

    // Uncapped total is reported...
    expect(bundle.now.count).toBe(15);
    // ...but the surfaced list and the stale list are both bounded to the cap.
    expect(bundle.now.items.length).toBe(12);
    expect(bundle.stale.now.length).toBe(12);
  });

  it('caps recent_observations at OBSERVATIONS_CAP (5) when more recent bullets exist', () => {
    // Dates 2026-06-13 .. 2026-06-20 — all within maxDays (7) of NOW (2026-06-20).
    const bullets = Array.from({ length: 8 }, (_, i) => `- 2026-06-${13 + i}: recent observation ${i + 1}.`).join('\n');
    writeFileSync(path.join(dir, '.tenbo/observations.md'), `# Observations\n\n${bullets}\n`);

    const bundle = resolveSessionContext(dir, { now: NOW });

    expect(bundle.recent_observations?.length).toBe(5);
  });
});

describe('resolveSessionContext — pending_reconciliation kind/layer detail (td-036)', () => {
  it('surfaces a bounded, deterministically-ordered per-entry breakdown for mixed kinds/layers', () => {
    writeFileSync(path.join(dir, '.tenbo/.pending-reconciliation.yaml'), [
      'items:',
      '  - opened_at: 2026-06-01',
      '    layer: dashboard:cli-tools',
      '    kind: doc-flag',
      '    description: commit touched cli-tools',
      '    source_commit: abc111',
      '  - opened_at: 2026-06-02',
      '    layer: dashboard:cli-tools',
      '    kind: intent_drift',
      '    description: entry point grew',
      '    source_commit: abc222',
      '  - opened_at: 2026-06-03',
      '    layer: dashboard:other-layer',
      '    kind: doc-flag',
      '    description: commit touched other-layer',
      '    source_commit: abc333',
      '',
    ].join('\n'));

    const bundle = resolveSessionContext(dir, { now: NOW });

    // 3 distinct entries; sorted by layer then kind (both doc-flag entries land in
    // dashboard:cli-tools and dashboard:other-layer groups; boundary_decision <
    // intent_drift alphabetically doesn't apply here but doc-flag < intent_drift does).
    expect(bundle.pending_reconciliation).toEqual({
      count: 3,
      path: '.tenbo/.pending-reconciliation.yaml',
      entries: [
        { layer: 'dashboard:cli-tools', kind: 'doc-flag' },
        { layer: 'dashboard:cli-tools', kind: 'intent_drift' },
        { layer: 'dashboard:other-layer', kind: 'doc-flag' },
      ],
    });
  });

  it('fails open to count 0 + empty entries when the ledger file is missing', () => {
    rmSync(path.join(dir, '.tenbo/.pending-reconciliation.yaml'));

    const bundle = resolveSessionContext(dir, { now: NOW });

    expect(bundle.pending_reconciliation).toEqual({
      count: 0,
      path: '.tenbo/.pending-reconciliation.yaml',
      entries: [],
    });
  });

  it('fails open to count 0 + empty entries (never throws) when the ledger file is malformed', () => {
    writeFileSync(path.join(dir, '.tenbo/.pending-reconciliation.yaml'), '{ this is not: [valid yaml');

    expect(() => resolveSessionContext(dir, { now: NOW })).not.toThrow();
    const bundle = resolveSessionContext(dir, { now: NOW });

    expect(bundle.pending_reconciliation).toEqual({
      count: 0,
      path: '.tenbo/.pending-reconciliation.yaml',
      entries: [],
    });
  });

  it('caps entries at the detail cap (12) while count still reports the full total', () => {
    const items = Array.from({ length: 15 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0');
      return [
        `  - opened_at: 2026-06-${n}`,
        `    layer: dashboard:layer-${n}`,
        '    kind: doc-flag',
        '    description: overflow fixture entry',
        `    source_commit: sha${n}`,
      ].join('\n');
    }).join('\n');
    writeFileSync(path.join(dir, '.tenbo/.pending-reconciliation.yaml'), `items:\n${items}\n`);

    const bundle = resolveSessionContext(dir, { now: NOW });

    expect(bundle.pending_reconciliation?.count).toBe(15);
    expect(bundle.pending_reconciliation?.entries.length).toBe(12);
    // First 12 in sorted (layer asc) order survive the cap.
    expect(bundle.pending_reconciliation?.entries[0]).toEqual({ layer: 'dashboard:layer-01', kind: 'doc-flag' });
    expect(bundle.pending_reconciliation?.entries[11]).toEqual({ layer: 'dashboard:layer-12', kind: 'doc-flag' });
  });
});

describe('resolveSessionContext — doc_staleness (td-027)', () => {
  const codeMapPath = () => path.join(dir, '.tenbo/scopes/dashboard/layers/cli-tools/code-map.md');

  it('returns an empty doc_staleness with a source-index warning when the index is missing', () => {
    const bundle = resolveSessionContext(dir, { now: NOW });

    expect(bundle.doc_staleness).toEqual({ stale_layers: [], checked_layers: 0 });
    expect(bundle.warnings).toContainEqual(expect.objectContaining({ kind: 'missing_source_index' }));
  });

  it('flags a layer whose code-map.md generated region no longer matches the source index', () => {
    const index = buildSourceIndex(dir, { now: NOW });
    writeSourceIndex(dir, index);
    // A hand-planted marker region with a hash that cannot match the current
    // index's `layerContentHash` — simulates drift after source files changed
    // without re-running `code-map generate`.
    writeFileSync(codeMapPath(), [
      '# CLI Tools — Code Map',
      '',
      '<!-- tenbo:auto:code-map begin -->',
      '<!-- Auto-generated by `tenbo-dashboard code-map generate` from the source index (content deadbeefcafe). '
        + 'Edits inside this block are overwritten on the next run — edit outside the markers instead. -->',
      '',
      '### Entry points (auto)',
      '_None detected._',
      '<!-- tenbo:auto:code-map end -->',
      '',
    ].join('\n'));

    const bundle = resolveSessionContext(dir, { now: NOW });

    expect(bundle.doc_staleness.checked_layers).toBe(1);
    expect(bundle.doc_staleness.stale_layers).toEqual([
      { scope: 'dashboard', layer: 'cli-tools', reason: expect.stringContaining('deadbeefcafe') },
    ]);
  });

  it('does not flag a layer whose code-map.md region matches the current index', () => {
    const index = buildSourceIndex(dir, { now: NOW });
    writeSourceIndex(dir, index);
    const state = readState(dir);
    const scope = state.scopes.find((entry) => entry.id === 'dashboard')!;
    const layer = scope.layers.find((entry) => entry.id === 'cli-tools')!;
    const { body } = buildStructuralBlock(index, scope, layer);
    const { content } = upsertMarkedRegion('', body, layer.name);
    writeFileSync(codeMapPath(), content);

    const bundle = resolveSessionContext(dir, { now: NOW });

    expect(bundle.doc_staleness.checked_layers).toBe(1);
    expect(bundle.doc_staleness.stale_layers).toEqual([]);
  });
});
