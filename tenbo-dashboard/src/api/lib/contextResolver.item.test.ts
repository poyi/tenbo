import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveItemContext } from './contextResolver';

let dir: string;
const NOW = new Date('2026-06-20T12:00:00.000Z');

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-context-item-'));
  mkdirSync(path.join(dir, '.git'));
  mkdirSync(path.join(dir, '.tenbo/scopes/dashboard/layers/cli-tools'), { recursive: true });
  mkdirSync(path.join(dir, '.tenbo/workpads'), { recursive: true });
  mkdirSync(path.join(dir, '.tenbo/specs'), { recursive: true });

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

  writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/architecture.yaml'), [
    'layers:',
    '  - id: cli-tools',
    '    name: CLI Tools',
    '    description: Commands for agents to fetch context.',
    '    files: ["bin/**", "scripts/**"]',
    '',
  ].join('\n'));

  writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/layers/cli-tools/intent.md'), [
    '# CLI Tools',
    '',
    '## Purpose',
    'Expose the dashboard as a CLI.',
    '',
    '## Optimizing for',
    '- **Determinism**: typed commands over hand-read YAML.',
    '',
    '## Anti-responsibilities',
    '- Does NOT contain validation logic — thin shell over the Data Layer.',
    '',
    '## Boundaries',
    '- **Upstream (depends on):** Data Layer.',
    '- **Downstream (depended on by):** the skill, human users.',
    '',
    '## Invariants',
    '- Every command works from any directory inside the repo.',
    '',
  ].join('\n'));
  writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/layers/cli-tools/code-map.md'), '# CLI Tools — Code Map\n');

  writeFileSync(path.join(dir, '.tenbo/specs/td-050-thing.md'), '---\ntenbo_item: td-050\n---\n# Thing\n');

  writeFileSync(path.join(dir, '.tenbo/workpads/td-050.md'), [
    '---',
    'item: td-050',
    'opened: 2026-06-15',
    'last_updated: 2026-06-19',
    'env: main@abc1234',
    '---',
    '',
    '## Plan',
    '',
    '- [x] 1. schema migration',
    '- [x] 2. backfill',
    '- [ ] 3. UI rollout',
    '',
    '## Acceptance Criteria',
    '',
    '- [x] migration ships',
    '- [ ] UI reflects new data',
    '',
    '## Validation',
    '',
    '- [ ] npm test',
    '',
  ].join('\n'));

  writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/roadmap.yaml'), [
    'items:',
    '  - id: td-050',
    '    title: Sample item under test',
    '    layer: cli-tools',
    '    status: next',
    '    type: feature',
    '    goal_ref: [g1]',
    '    description: A representative item for item-context tests.',
    '    notes: "2026-06-01: captured. Should not leak into the bundle."',
    '    done_when:',
    '      - "does the thing"',
    '    risks:',
    '      - "scope creep"',
    '    files_to_read:',
    '      - tenbo-dashboard/src/api/lib/contextResolver.ts',
    '    links:',
    '      - .tenbo/specs/td-050-thing.md',
    '    workpad: .tenbo/workpads/td-050.md',
    '  - id: td-051',
    '    title: Item without a workpad',
    '    layer: cli-tools',
    '    status: later',
    '    description: Used to test the no-workpad path.',
    '',
  ].join('\n'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveItemContext', () => {
  it('builds a bounded per-item bundle with layer constraints, read plan, and workpad state', () => {
    const bundle = resolveItemContext(dir, 'td-050', { now: NOW });

    expect(bundle.ok).toBe(true);
    expect(bundle.intent).toBe('item');
    expect(bundle.item_id).toBe('td-050');
    expect(bundle.scope).toBe('dashboard');

    // Core item fields — execution detail (done_when/risks included), notes excluded.
    expect(bundle.item).toMatchObject({
      id: 'td-050',
      title: 'Sample item under test',
      status: 'next',
      done_when: ['does the thing'],
      risks: ['scope creep'],
    });
    expect(bundle.item).not.toHaveProperty('notes');

    // Layer constraints for the item's own layer (cli-tools).
    expect(bundle.layer_constraints).toEqual([
      {
        scope: 'dashboard',
        layer: 'cli-tools',
        optimizing_for: ['**Determinism**: typed commands over hand-read YAML.'],
        anti_responsibilities: ['Does NOT contain validation logic — thin shell over the Data Layer.'],
        boundaries: [
          '**Upstream (depends on):** Data Layer.',
          '**Downstream (depended on by):** the skill, human users.',
        ],
        invariants: ['Every command works from any directory inside the repo.'],
      },
    ]);

    // Read plan: bounded, includes files_to_read, layer intent/code-map, and the linked spec.
    expect(bundle.context.layer_docs).toEqual([
      '.tenbo/scopes/dashboard/layers/cli-tools/intent.md',
      '.tenbo/scopes/dashboard/layers/cli-tools/code-map.md',
    ]);
    expect(bundle.context.files_to_read).toEqual(['tenbo-dashboard/src/api/lib/contextResolver.ts']);
    expect(bundle.context.read_plan.length).toBeLessThanOrEqual(12);
    expect(bundle.context.read_plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.tenbo/overview.md', kind: 'product' }),
      expect.objectContaining({ path: '.tenbo/scopes/dashboard/layers/cli-tools/intent.md', kind: 'layer-intent' }),
      expect.objectContaining({ path: '.tenbo/scopes/dashboard/layers/cli-tools/code-map.md', kind: 'layer-code-map' }),
      expect.objectContaining({ path: '.tenbo/specs/td-050-thing.md', kind: 'spec' }),
      expect.objectContaining({ path: 'tenbo-dashboard/src/api/lib/contextResolver.ts', kind: 'source-file' }),
    ]));

    // Workpad state.
    expect(bundle.workpad).toEqual({
      exists: true,
      path: '.tenbo/workpads/td-050.md',
      item: 'td-050',
      opened: '2026-06-15',
      last_updated: '2026-06-19',
      env: 'main@abc1234',
      plan: { total: 3, checked: 2, unchecked_preview: ['3. UI rollout'] },
      acceptance_criteria: { total: 2, checked: 1 },
      validation: { total: 1, checked: 0 },
    });

    // agent-context.md is absent from this fixture — fails open with a warning.
    expect(bundle.warnings).toContainEqual(expect.objectContaining({ kind: 'missing_agent_context' }));
  });

  it('reports workpad.exists: false when the item has no workpad', () => {
    const bundle = resolveItemContext(dir, 'td-051', { now: NOW });

    expect(bundle.workpad).toEqual({ exists: false });
    expect(bundle.layer_constraints).toEqual([
      expect.objectContaining({ scope: 'dashboard', layer: 'cli-tools' }),
    ]);
  });

  it('throws a not_found RoadmapStoreError for an unknown item id', () => {
    expect(() => resolveItemContext(dir, 'zz-999')).toThrow(/not found/);
  });

  it('caps layer_constraints at LAYER_CONSTRAINTS_CAP (5) when an item spans more layers', () => {
    // 6 layers, each with an intent.md so it would produce a layer_constraints entry.
    const layerIds = Array.from({ length: 6 }, (_, i) => `layer-${i + 1}`);
    const archLayers = layerIds.map((id) => [
      `  - id: ${id}`,
      `    name: Layer ${id}`,
      `    description: Overflow fixture layer ${id}.`,
      `    files: ["src/${id}/**"]`,
    ].join('\n')).join('\n');
    writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/architecture.yaml'), `layers:\n${archLayers}\n`);
    for (const id of layerIds) {
      mkdirSync(path.join(dir, '.tenbo/scopes/dashboard/layers', id), { recursive: true });
      writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/layers', id, 'intent.md'), `# ${id}\n`);
    }

    writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/roadmap.yaml'), [
      'items:',
      '  - id: td-060',
      '    title: Item spanning many layers',
      `    layers: [${layerIds.join(', ')}]`,
      '    status: next',
      '    description: Overflow fixture item spanning more than the layer cap.',
      '',
    ].join('\n'));

    const bundle = resolveItemContext(dir, 'td-060', { now: NOW });

    expect(bundle.layer_constraints.length).toBe(5);
  });
});
