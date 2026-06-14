import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  addItemNote,
  findItem,
  linkItemCommit,
  listItems,
  listNextItems,
  setItemStatus,
  setItemVerification,
} from './roadmapStore';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-roadmap-store-'));
  mkdirSync(path.join(dir, '.git'));
  mkdirSync(path.join(dir, '.tenbo/scopes/editor/layers/app'), { recursive: true });
  writeFileSync(path.join(dir, '.tenbo/workspace.yaml'), [
    'scopes:',
    '  - id: editor',
    '    path: apps/editor',
    '    description: editor scope',
    'cross_cutting: []',
    '',
  ].join('\n'));
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/architecture.yaml'), [
    'layers:',
    '  - id: app',
    '    name: App',
    '    description: application layer',
    '    files: ["src/**"]',
    '',
  ].join('\n'));
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/README.md'), '# App\n');
  writeFileSync(path.join(dir, '.tenbo/overview.md'), '# Overview\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
    'items:',
    '  - id: ed-001',
    '    title: First',
    '    layer: app',
    '    status: next',
    '    priority: p1',
    '    goal_ref: [g1]',
    '    description: first item',
    '    done_when:',
    '      - it works',
    '  - id: ed-002',
    '    title: Second',
    '    layer: app',
    '    status: done',
    '    description: second item',
    '    verification:',
    '      status: pending_live',
    '      updated_at: 2026-06-14T10:00:00.000Z',
    '',
  ].join('\n'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('roadmapStore', () => {
  it('finds an item by id without the caller knowing the roadmap path', () => {
    const located = findItem(dir, 'ed-001');

    expect(located.scopeId).toBe('editor');
    expect(located.filePath).toBe(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'));
    expect(located.item.title).toBe('First');
  });

  it('sets status through a typed mutation', () => {
    const result = setItemStatus(dir, 'ed-001', 'now');

    expect(result.item.status).toBe('now');
    expect(readFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'utf8')).toContain('status: now');
  });

  it('rejects a mutation when the roadmap file changes before write', () => {
    expect(() => setItemStatus(dir, 'ed-001', 'now', {
      beforeWrite: () => appendFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), '# concurrent change\n'),
    })).toThrow(/roadmap changed/);
  });

  it('appends dated notes instead of replacing existing notes', () => {
    addItemNote(dir, 'ed-001', 'Implementation complete', {
      now: () => new Date('2026-06-14T12:00:00.000Z'),
    });
    const result = addItemNote(dir, 'ed-001', 'Needs live verification', {
      now: () => new Date('2026-06-14T12:05:00.000Z'),
    });

    expect(result.item.notes).toContain('- 2026-06-14: Implementation complete');
    expect(result.item.notes).toContain('- 2026-06-14: Needs live verification');
  });

  it('sets verification independently from implementation status', () => {
    const result = setItemVerification(dir, 'ed-001', {
      status: 'pending_live',
      evidence: ['npm test -- --run'],
      note: 'Needs manual browser check',
      now: () => new Date('2026-06-14T12:00:00.000Z'),
    });

    expect(result.item.status).toBe('next');
    expect(result.item.verification).toEqual({
      status: 'pending_live',
      updated_at: '2026-06-14T12:00:00.000Z',
      evidence: ['npm test -- --run'],
      note: 'Needs manual browser check',
    });
  });

  it('links commits without duplicating an existing commit link', () => {
    linkItemCommit(dir, 'ed-001', '7fc09a5');
    const result = linkItemCommit(dir, 'ed-001', '7fc09a5');

    expect(result.item.links).toEqual(['commit:7fc09a5']);
  });

  it('lists next work in status and priority order', () => {
    const items = listNextItems(dir);

    expect(items.map((entry) => entry.item.id)).toEqual(['ed-001']);
    expect(items[0].scopeId).toBe('editor');
  });

  it('lists items by status and verification status', () => {
    const items = listItems(dir, { status: 'done', verification: 'pending_live' });

    expect(items.map((entry) => entry.item.id)).toEqual(['ed-002']);
  });
});
