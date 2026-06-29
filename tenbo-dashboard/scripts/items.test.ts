import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runItemsCli } from './items';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-items-cli-'));
  mkdirSync(path.join(dir, '.git'));
  mkdirSync(path.join(dir, '.tenbo/scopes/editor/layers/app'), { recursive: true });
  writeFileSync(path.join(dir, '.tenbo/workspace.yaml'), 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor scope\ncross_cutting: []\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/architecture.yaml'), 'layers:\n  - id: app\n    name: App\n    description: application layer\n    files: ["src/**"]\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/README.md'), '# App\n');
  writeFileSync(path.join(dir, '.tenbo/overview.md'), '# Overview\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
    'items:',
    '  - id: ed-001',
    '    title: First',
    '    layer: app',
    '    status: done',
    '    description: first item',
    '    verification:',
    '      status: pending_live',
    '      updated_at: 2026-06-14T10:00:00.000Z',
    '  - id: ed-002',
    '    title: Second',
    '    layer: app',
    '    status: next',
    '    type: feature',
    '    description: second item',
    '    notes: |',
    '      - 2026-06-14: Long implementation note that summary should not dump wholesale.',
    '  - id: ed-003',
    '    title: Third',
    '    layer: app',
    '    status: later',
    '    type: refactor',
    '    priority: p1',
    '    description: third item',
    '    verification:',
    '      status: verified',
    '      updated_at: 2026-06-15T10:00:00.000Z',
    '',
  ].join('\n'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('items CLI', () => {
  it('filters by status and verification status as JSON', () => {
    const result = runItemsCli(dir, ['--status', 'done', '--verification', 'pending_live', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.items.map((entry: { item: { id: string } }) => entry.item.id)).toEqual(['ed-001']);
  });

  it('filters by type and comma-separated statuses with selected fields', () => {
    const result = runItemsCli(dir, [
      '--type',
      'refactor',
      '--status',
      'next,later',
      '--fields',
      'id,title,status,priority,layer,verification',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.items).toEqual([
      {
        id: 'ed-003',
        title: 'Third',
        status: 'later',
        priority: 'p1',
        layer: 'app',
        verification: 'verified',
      },
    ]);
  });

  it('includes goal_ref in selected compact fields', () => {
    writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
      'items:',
      '  - id: ed-001',
      '    title: First',
      '    layer: app',
      '    status: next',
      '    description: first item',
      '    goal_ref: [g1, g2]',
      '',
    ].join('\n'));

    const result = runItemsCli(dir, ['--fields', 'id,title,goal_ref', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).items).toEqual([
      { id: 'ed-001', title: 'First', goal_ref: ['g1', 'g2'] },
    ]);
  });

  it('returns compact summaries without changing full JSON by default', () => {
    const summary = runItemsCli(dir, ['--status', 'next', '--summary', '--json']);
    const full = runItemsCli(dir, ['--status', 'next', '--json']);

    expect(summary.exitCode).toBe(0);
    expect(JSON.parse(summary.stdout).items).toEqual([
      expect.objectContaining({
        id: 'ed-002',
        title: 'Second',
        status: 'next',
        type: 'feature',
        layer: 'app',
      }),
    ]);
    expect(JSON.parse(summary.stdout).items[0]).not.toHaveProperty('description');
    expect(JSON.parse(full.stdout).items[0].item.description).toBe('second item');
  });

  it('summarizes items whose notes are YAML sequences', () => {
    writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
      'items:',
      '  - id: ed-001',
      '    title: First',
      '    layer: app',
      '    status: next',
      '    description: first item',
      '    notes:',
      '      - First note',
      '      - Latest list note',
      '',
    ].join('\n'));

    const result = runItemsCli(dir, ['--status', 'next', '--summary', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).items).toEqual([
      expect.objectContaining({
        id: 'ed-001',
        latest_note: 'Latest list note',
      }),
    ]);
  });

  it('returns misuse errors for invalid status lists and fields', () => {
    const badStatus = runItemsCli(dir, ['--status', 'next,unknown', '--json']);
    const badField = runItemsCli(dir, ['--fields', 'id,nope', '--json']);

    expect(badStatus.exitCode).toBe(2);
    expect(JSON.parse(badStatus.stderr)).toMatchObject({ ok: false, error: 'invalid_args' });
    expect(badField.exitCode).toBe(2);
    expect(JSON.parse(badField.stderr)).toMatchObject({ ok: false, error: 'invalid_args' });
  });
});
