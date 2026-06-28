import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runWorkQueueCli } from './work-queue';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-work-queue-cli-'));
  mkdirSync(path.join(dir, '.git'));
  mkdirSync(path.join(dir, '.tenbo/scopes/editor/layers/app'), { recursive: true });
  writeFileSync(path.join(dir, '.tenbo/workspace.yaml'), 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor scope\ncross_cutting: []\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/architecture.yaml'), 'layers:\n  - id: app\n    name: App\n    description: application layer\n    files: ["src/**"]\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/README.md'), '# App\n');
  writeFileSync(path.join(dir, '.tenbo/overview.md'), '# Overview\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
    'items:',
    '  - id: ed-001',
    '    title: Active Refactor',
    '    layer: app',
    '    status: now',
    '    type: refactor',
    '    priority: p2',
    '    description: active refactor',
    '    done_when:',
    '      - Refactor lands.',
    '    files_to_read:',
    '      - src/app.ts',
    '  - id: ed-002',
    '    title: Later Refactor',
    '    layer: app',
    '    status: later',
    '    type: refactor',
    '    priority: p1',
    '    description: later refactor',
    '  - id: ed-003',
    '    title: Later Feature',
    '    layer: app',
    '    status: later',
    '    type: feature',
    '    description: later feature',
    '',
  ].join('\n'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('work-queue CLI', () => {
  it('returns compact actionable candidates filtered by type and status', () => {
    const result = runWorkQueueCli(dir, ['--type', 'refactor', '--status', 'now,later', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      recommended_sequence: ['ed-001', 'ed-002'],
    });
    expect(payload.items).toEqual([
      expect.objectContaining({ id: 'ed-001', title: 'Active Refactor', status: 'now', type: 'refactor' }),
      expect.objectContaining({ id: 'ed-002', title: 'Later Refactor', status: 'later', type: 'refactor' }),
    ]);
    expect(payload.items[0]).not.toHaveProperty('description');
  });
});
