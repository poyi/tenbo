import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runNextCli } from './next';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-next-cli-'));
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
    '    status: later',
    '    description: first item',
    '  - id: ed-002',
    '    title: Second',
    '    layer: app',
    '    status: next',
    '    priority: p0',
    '    description: second item',
    '    type: refactor',
    '    done_when:',
    '      - Next work lands.',
    '    files_to_read:',
    '      - src/next.ts',
    '',
  ].join('\n'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('next CLI', () => {
  it('returns next work as JSON', () => {
    const result = runNextCli(dir, ['--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.items.map((entry: { item: { id: string } }) => entry.item.id)).toEqual(['ed-002']);
  });

  it('returns compact agent summary for next work', () => {
    const result = runNextCli(dir, ['--agent-summary', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.recommended_sequence).toEqual(['ed-002']);
    expect(payload.items).toEqual([
      expect.objectContaining({
        id: 'ed-002',
        title: 'Second',
        status: 'next',
        type: 'refactor',
        priority: 'p0',
      }),
    ]);
    expect(payload.items[0]).not.toHaveProperty('description');
  });

  it('returns agent summaries when notes are YAML sequences', () => {
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

    const result = runNextCli(dir, ['--agent-summary', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).items).toEqual([
      expect.objectContaining({
        id: 'ed-001',
        latest_note: 'Latest list note',
      }),
    ]);
  });
});
