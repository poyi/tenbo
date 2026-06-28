import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runItemCli } from './item';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-item-cli-'));
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
    '    status: next',
    '    description: first item',
    '    type: refactor',
    '    done_when:',
    '      - First item lands.',
    '    files_to_read:',
    '      - src/app.ts',
    '    risks:',
    '      - May overlap active work.',
    '',
  ].join('\n'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('item CLI', () => {
  it('prints canonical JSON for item show --json', () => {
    const result = runItemCli(dir, ['show', 'ed-001', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      item: { id: 'ed-001', status: 'next' },
      scope: 'editor',
    });
  });

  it('sets status and prints concise text by default', () => {
    const result = runItemCli(dir, ['set-status', 'ed-001', 'done']);

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'ed-001 status: done\n',
      stderr: '',
    });
  });

  it('prints an active task brief as compact JSON', () => {
    const result = runItemCli(dir, ['brief', 'ed-001', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      item: {
        id: 'ed-001',
        title: 'First',
        status: 'next',
        type: 'refactor',
        layer: 'app',
      },
      files_to_read: ['src/app.ts'],
      acceptance_criteria: ['First item lands.'],
      risks: ['May overlap active work.'],
    });
    expect(payload.item).not.toHaveProperty('description');
  });

  it('prints a handoff prompt for another agent', () => {
    const result = runItemCli(dir, ['handoff', 'ed-001', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      item_id: 'ed-001',
    });
    expect(payload.prompt).toContain('Files to read');
    expect(payload.prompt).toContain('src/app.ts');
    expect(payload.prompt).toContain('Acceptance criteria');
    expect(payload.prompt).toContain('First item lands.');
    expect(payload.prompt).toContain('Non-goals');
    expect(payload.prompt).toContain('Completion rules');
  });

  it('adds a note when existing notes are a YAML sequence', () => {
    writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
      'items:',
      '  - id: ed-001',
      '    title: First',
      '    layer: app',
      '    status: next',
      '    description: first item',
      '    notes:',
      '      - Existing list note',
      '',
    ].join('\n'));

    const result = runItemCli(dir, ['add-note', 'ed-001', 'Added from CLI', '--json']);
    const roadmap = readFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'utf8');
    const today = new Date().toISOString().slice(0, 10);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).item.notes).toContain('- Existing list note');
    expect(JSON.parse(result.stdout).item.notes).toContain(`- ${today}: Added from CLI`);
    expect(roadmap).toContain(`- ${today}: Added from CLI`);
  });

  it('sets verification status and evidence', () => {
    const result = runItemCli(dir, [
      'verify',
      'ed-001',
      '--status',
      'pending_live',
      '--evidence',
      'npm test -- --run',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).item.verification).toMatchObject({
      status: 'pending_live',
      evidence: ['npm test -- --run'],
    });
  });

  it('checks item evidence without mutating verification metadata', () => {
    const result = runItemCli(dir, ['verify', 'ed-001', '--check', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      item_id: 'ed-001',
      verdict: 'likely_open',
    });
    expect(findRoadmap()).not.toContain('verification:');
  });

  it('reports inconsistent evidence for done items missing hygiene fields', () => {
    writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
      'items:',
      '  - id: ed-001',
      '    title: First',
      '    layer: app',
      '    status: done',
      '    description: first item',
      '',
    ].join('\n'));

    const result = runItemCli(dir, ['verify', 'ed-001', '--check', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      verdict: 'inconsistent',
      missing: expect.arrayContaining(['verification', 'doc_update']),
    });
  });

  it('sets doc_update from the CLI', () => {
    const dated = runItemCli(dir, ['doc-update', 'ed-001', '--date', 'today', '--json']);
    const skipped = runItemCli(dir, ['doc-update', 'ed-001', '--skipped', '--reason', 'No docs changed.', '--json']);
    const today = new Date().toISOString().slice(0, 10);

    expect(dated.exitCode).toBe(0);
    expect(JSON.parse(dated.stdout).item.doc_update).toBe(today);
    expect(skipped.exitCode).toBe(0);
    expect(JSON.parse(skipped.stdout).item.doc_update).toBe('skipped — No docs changed.');
  });

  it('completes an item from the CLI in one roadmap transaction', () => {
    const result = runItemCli(dir, [
      'complete',
      'ed-001',
      '--evidence',
      'npm test -- --run',
      '--doc-update',
      'today',
      '--commit',
      'abc123',
      '--json',
    ]);
    const today = new Date().toISOString().slice(0, 10);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.item).toMatchObject({
      status: 'done',
      doc_update: today,
      links: ['commit:abc123'],
      verification: {
        status: 'verified',
        evidence: ['npm test -- --run'],
      },
    });
    expect(payload.item.notes).toContain(`- ${today}: Completed with evidence: npm test -- --run`);
    expect(payload.validation).toHaveProperty('errors');
  });

  it('returns a structured error for missing items', () => {
    const result = runItemCli(dir, ['show', 'ed-999', '--json']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: 'not_found',
    });
  });

  it('returns misuse exit code for unknown item commands', () => {
    const result = runItemCli(dir, ['unknown', 'ed-001', '--json']);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: 'invalid_args',
    });
  });
});

function findRoadmap(): string {
  return readFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'utf8');
}
