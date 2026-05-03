import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { readState } from './tenboFs';

function makeTenbo(structure: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), 'tenbo-v2-'));
  for (const [rel, content] of Object.entries(structure)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe('readState v2 extensions', () => {
  it('reports layerDocs.hasIntent and hasCodeMap when present', () => {
    const root = makeTenbo({
      '.tenbo/workspace.yaml': 'scopes:\n  - id: e\n    path: .\n    description: ok\ncross_cutting: []\n',
      '.tenbo/scopes/e/architecture.yaml': 'layers:\n  - id: l\n    name: L\n    description: a layer here\n    files: ["**/*"]\n',
      '.tenbo/scopes/e/roadmap.yaml': 'items: []\n',
      '.tenbo/scopes/e/layers/l/README.md': '# L\n',
      '.tenbo/scopes/e/layers/l/intent.md': '# L\n',
      '.tenbo/scopes/e/layers/l/code-map.md': '# L\n',
    });
    const state = readState(root);
    expect(state.layerDocs?.['e/l'].hasIntent).toBe(true);
    expect(state.layerDocs?.['e/l'].hasCodeMap).toBe(true);
    expect(typeof state.layerDocs?.['e/l'].intentMtime).toBe('number');
  });

  it('reads cross-cutting roadmap from .tenbo/roadmap.yaml', () => {
    const root = makeTenbo({
      '.tenbo/workspace.yaml': 'scopes: []\ncross_cutting: []\n',
      '.tenbo/roadmap.yaml': 'items:\n  - id: x-001\n    title: cross thing\n    layers: []\n    status: later\n    description: spans many things across the system\n',
    });
    const state = readState(root);
    expect(state.crossCuttingRoadmap?.length).toBe(1);
    expect(state.crossCuttingRoadmap?.[0].id).toBe('x-001');
  });

  it('reports absent v2 files cleanly', () => {
    const root = makeTenbo({
      '.tenbo/workspace.yaml': 'scopes:\n  - id: e\n    path: .\n    description: ok\ncross_cutting: []\n',
      '.tenbo/scopes/e/architecture.yaml': 'layers:\n  - id: l\n    name: L\n    description: a small layer for testing\n    files: ["**/*"]\n',
      '.tenbo/scopes/e/roadmap.yaml': 'items: []\n',
      '.tenbo/scopes/e/layers/l/README.md': '# L\n',
    });
    const state = readState(root);
    expect(state.layerDocs?.['e/l'].hasIntent).toBe(false);
    expect(state.crossCuttingRoadmap).toEqual([]);
    expect(state.metrics).toBeUndefined();
  });

  it('reads metrics.json when present', () => {
    const root = makeTenbo({
      '.tenbo/workspace.yaml': 'scopes:\n  - id: e\n    path: .\n    description: ok\ncross_cutting: []\n',
      '.tenbo/scopes/e/architecture.yaml': 'layers:\n  - id: l\n    name: L\n    description: a layer here\n    files: ["**/*"]\n',
      '.tenbo/scopes/e/roadmap.yaml': 'items: []\n',
      '.tenbo/scopes/e/layers/l/README.md': '# L\n',
      '.tenbo/scopes/e/metrics.json': JSON.stringify({
        generated_at: '2026-04-26T00:00:00Z',
        layers: { l: { file_count: 3, total_lines: 42, outbound_deps: 0, deep_dive_count: 0, intent_age_days: null, pct_roadmap_in_now: 0 } },
      }),
    });
    const state = readState(root);
    expect(state.metrics?.['e'].layers.l.file_count).toBe(3);
    expect(state.metrics?.['e'].generated_at).toBe('2026-04-26T00:00:00Z');
  });

  it('tolerates malformed metrics.json without crashing readState', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = makeTenbo({
      '.tenbo/workspace.yaml': 'scopes:\n  - id: e\n    path: .\n    description: ok\ncross_cutting: []\n',
      '.tenbo/scopes/e/architecture.yaml': 'layers:\n  - id: l\n    name: L\n    description: a layer here\n    files: ["**/*"]\n',
      '.tenbo/scopes/e/roadmap.yaml': 'items: []\n',
      '.tenbo/scopes/e/layers/l/README.md': '# L\n',
      '.tenbo/scopes/e/metrics.json': '{ not valid json',
    });
    const state = readState(root);
    expect(state.metrics).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
