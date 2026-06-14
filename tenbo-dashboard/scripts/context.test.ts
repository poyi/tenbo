import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runContextCli } from './context';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-context-cli-'));
  mkdirSync(path.join(dir, '.git'));
  mkdirSync(path.join(dir, '.tenbo/scopes/dashboard/layers/cli-tools'), { recursive: true });
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
  writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/layers/cli-tools/intent.md'), '# CLI Tools\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/roadmap.yaml'), [
    'items:',
    '  - id: td-010',
    '    title: Add context command',
    '    layer: cli-tools',
    '    status: next',
    '    goal_ref: [g1]',
    '    description: Add a context command for feature planning.',
    '',
  ].join('\n'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('context CLI', () => {
  it('prints feature context as JSON', () => {
    const result = runContextCli(dir, ['feature', '--query', 'build a context command for agents', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      intent: 'feature',
      recommendation: {
        scope: 'dashboard',
        layers: ['cli-tools'],
      },
    });
    expect(payload.roadmap.matching_items.map((entry: { item: { id: string } }) => entry.item.id)).toEqual(['td-010']);
  });

  it('rejects feature context requests without a query', () => {
    const result = runContextCli(dir, ['feature', '--json']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: 'invalid_args',
    });
  });
});
