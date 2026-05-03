import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readState, patchItem, reorderItems, listLayerDocs } from '../../src/api/lib/tenboFs';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-'));
  mkdirSync(path.join(dir, '.git'));
  mkdirSync(path.join(dir, '.tenbo/scopes/editor/layers'), { recursive: true });
  writeFileSync(path.join(dir, '.tenbo/workspace.yaml'),
    'scopes:\n  - id: editor\n    path: apps/editor\n    description: "x"\ncross_cutting: []\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/architecture.yaml'),
    'layers:\n  - id: a\n    name: A\n    description: "the a layer"\n    files: ["src/a/**"]\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'),
    'items:\n  - id: rm-001\n    title: First\n    layer: a\n    status: later\n    description: "first"\n  - id: rm-002\n    title: Second\n    layer: a\n    status: later\n    description: "second"\n');
  mkdirSync(path.join(dir, '.tenbo/scopes/editor/layers/a'), { recursive: true });
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/a/README.md'), '# A\nthe a layer narrative.\n');
  writeFileSync(path.join(dir, '.tenbo/overview.md'), '# overview\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('tenboFs', () => {
  it('reads full state', () => {
    const state = readState(dir);
    expect(state.scopes).toHaveLength(1);
    expect(state.scopes[0].layers[0].id).toBe('a');
    expect(state.scopes[0].items.map(i => i.id)).toEqual(['rm-001', 'rm-002']);
    expect(state.narratives['editor/a']).toContain('the a layer narrative');
  });

  it('patches a single item field', () => {
    patchItem(dir, 'editor', 'rm-001', { status: 'now' });
    const state = readState(dir);
    expect(state.scopes[0].items[0].status).toBe('now');
  });

  it('reorders items in a scope', () => {
    reorderItems(dir, 'editor', ['rm-002', 'rm-001']);
    const state = readState(dir);
    expect(state.scopes[0].items.map(i => i.id)).toEqual(['rm-002', 'rm-001']);
  });

  it('lists deep technical docs in a layer dir, excluding README', () => {
    writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/a/architecture.md'), '# Architecture of A\n...');
    writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/a/governance.md'), 'no h1 in this one');
    const docs = listLayerDocs(dir, 'editor', 'a');
    expect(docs.map(d => d.filename)).toEqual(['architecture.md', 'governance.md']);
    expect(docs.find(d => d.filename === 'architecture.md')?.title).toBe('Architecture of A');
    expect(docs.find(d => d.filename === 'governance.md')?.title).toBeNull();
  });
});
