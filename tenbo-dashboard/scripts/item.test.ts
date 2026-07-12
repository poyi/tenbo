import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  it('prints canonical JSON for item show --json', async () => {
    const result = await runItemCli(dir, ['show', 'ed-001', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      item: { id: 'ed-001', status: 'next' },
      scope: 'editor',
    });
  });

  it('sets status directly and prints a fallback notice when no hub is running (td-029)', async () => {
    // The fallback notice is written straight to process.stderr (not the
    // CliResult.stderr error envelope, which is reserved for failures) — spy
    // on the real stream to observe it.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await runItemCli(dir, ['set-status', 'ed-001', 'done']);

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'ed-001 status: done\n',
      stderr: '',
    });
    expect(stderrSpy).toHaveBeenCalledWith('note: no tenbo hub running, writing files directly\n');
    stderrSpy.mockRestore();
    // The write actually landed on disk via the direct roadmapStore path.
    expect(findRoadmap()).toContain('status: done');
  });

  it('sets status when a boolean flag precedes the positionals (td-032)', async () => {
    // --json is boolean; it must not swallow "ed-001" as its "value" when
    // placed before the positional args.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await runItemCli(dir, ['set-status', '--json', 'ed-001', 'done']);
    stderrSpy.mockRestore();

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      item: { id: 'ed-001', status: 'done' },
    });
    expect(findRoadmap()).toContain('status: done');
  });

  it('still consumes a value-taking flag placed before the positionals (td-032)', async () => {
    // --agent DOES take a value; positionalArgs must keep skipping it and
    // its value even though it now defaults to leaving unknown flags alone.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const setResult = await runItemCli(dir, ['set-status', '--agent', 'tester', 'ed-001', 'done']);
    stderrSpy.mockRestore();
    expect(setResult.exitCode).toBe(0);

    const history = await runItemCli(dir, ['history', 'ed-001', '--json']);
    expect(history.exitCode).toBe(0);
    const payload = JSON.parse(history.stdout);
    expect(payload.events[0]).toMatchObject({ actor: 'tester', operation: 'set-status' });
  });

  it('prints an active task brief as compact JSON', async () => {
    const result = await runItemCli(dir, ['brief', 'ed-001', '--json']);

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

  it('prints a handoff prompt for another agent', async () => {
    const result = await runItemCli(dir, ['handoff', 'ed-001', '--json']);

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

  it('adds a note when existing notes are a YAML sequence', async () => {
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

    // td-030: pass --agent explicitly so the attributed note text is
    // deterministic (unset, it would fall back to the OS username, which
    // varies across environments).
    const result = await runItemCli(dir, ['add-note', 'ed-001', 'Added from CLI', '--agent', 'test-agent', '--json']);
    const roadmap = readFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'utf8');
    const today = new Date().toISOString().slice(0, 10);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).item.notes).toContain('- Existing list note');
    expect(JSON.parse(result.stdout).item.notes).toContain(`- ${today} [test-agent]: Added from CLI`);
    expect(roadmap).toContain(`- ${today} [test-agent]: Added from CLI`);
  });

  it('sets verification status and evidence', async () => {
    const result = await runItemCli(dir, [
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

  it('checks item evidence without mutating verification metadata', async () => {
    const result = await runItemCli(dir, ['verify', 'ed-001', '--check', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      item_id: 'ed-001',
      verdict: 'likely_open',
    });
    expect(findRoadmap()).not.toContain('verification:');
  });

  it('executes structured done_when checks and records pass/fail evidence on verification (x-003)', async () => {
    writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
      'items:',
      '  - id: ed-001',
      '    title: First',
      '    layer: app',
      '    status: next',
      '    description: first item',
      '    type: refactor',
      '    done_when:',
      '      - Prose-only bullet, never executed.',
      '      - text: passing check',
      '        check:',
      '          run: "true"',
      '',
    ].join('\n'));

    const result = await runItemCli(dir, ['verify', 'ed-001', '--check', '--agent', 'test-agent', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      item_id: 'ed-001',
      passed: true,
      checked_count: 1,
      manual_count: 1,
      failed_count: 0,
    });
    expect(payload.results).toEqual([
      { text: 'Prose-only bullet, never executed.', kind: 'manual', status: 'manual' },
      expect.objectContaining({ text: 'passing check', kind: 'check', status: 'pass', run: 'true', exit_code: 0, expect_exit: 0, timed_out: false }),
    ]);
    expect(payload.verification).toMatchObject({ status: 'verified', actor: 'test-agent' });
    expect(findRoadmap()).toContain('verification:');
    expect(findRoadmap()).toContain('status: verified');
  });

  it('reports a failing structured check and sets verification status to failed', async () => {
    writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
      'items:',
      '  - id: ed-001',
      '    title: First',
      '    layer: app',
      '    status: next',
      '    description: first item',
      '    done_when:',
      '      - text: failing check',
      '        check:',
      '          run: "false"',
      '',
    ].join('\n'));

    const result = await runItemCli(dir, ['verify', 'ed-001', '--check', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ passed: false, checked_count: 1, failed_count: 1 });
    expect(payload.results[0]).toMatchObject({ status: 'fail', exit_code: 1, expect_exit: 0 });
    expect(payload.verification.status).toBe('failed');
    expect(findRoadmap()).toContain('status: failed');
  });

  it('kills a timing-out structured check and reports it failed (strict timeout, TERM then KILL)', async () => {
    writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
      'items:',
      '  - id: ed-001',
      '    title: First',
      '    layer: app',
      '    status: next',
      '    description: first item',
      '    done_when:',
      '      - text: times out',
      '        check:',
      '          run: "sleep 10"',
      '          timeout_ms: 300',
      '',
    ].join('\n'));

    const start = Date.now();
    const result = await runItemCli(dir, ['verify', 'ed-001', '--check', '--json']);
    const elapsed = Date.now() - start;

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.passed).toBe(false);
    expect(payload.results[0]).toMatchObject({ status: 'fail', timed_out: true });
    expect(payload.verification.status).toBe('failed');
    // Proves the process was actually killed rather than the CLI just waiting out the sleep.
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);

  it('does not execute anything for an item whose done_when is entirely plain-string (manual-only)', async () => {
    // ed-001 from beforeEach has only plain-string done_when — this is the
    // pre-x-003 behavior, and must remain untouched: no execution, no mutation.
    const result = await runItemCli(dir, ['verify', 'ed-001', '--check', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.verdict).toBe('likely_open');
    expect(payload.results).toBeUndefined();
    expect(payload.passed).toBeUndefined();
    expect(findRoadmap()).not.toContain('verification:');
  });

  it('reports inconsistent evidence for done items missing hygiene fields', async () => {
    writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
      'items:',
      '  - id: ed-001',
      '    title: First',
      '    layer: app',
      '    status: done',
      '    description: first item',
      '',
    ].join('\n'));

    const result = await runItemCli(dir, ['verify', 'ed-001', '--check', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      verdict: 'inconsistent',
      missing: expect.arrayContaining(['verification', 'doc_update']),
    });
  });

  it('sets doc_update from the CLI', async () => {
    const dated = await runItemCli(dir, ['doc-update', 'ed-001', '--date', 'today', '--json']);
    const skipped = await runItemCli(dir, ['doc-update', 'ed-001', '--skipped', '--reason', 'No docs changed.', '--json']);
    const today = new Date().toISOString().slice(0, 10);

    expect(dated.exitCode).toBe(0);
    expect(JSON.parse(dated.stdout).item.doc_update).toBe(today);
    expect(skipped.exitCode).toBe(0);
    expect(JSON.parse(skipped.stdout).item.doc_update).toBe('skipped — No docs changed.');
  });

  it('completes an item from the CLI in one roadmap transaction', async () => {
    const result = await runItemCli(dir, [
      'complete',
      'ed-001',
      '--evidence',
      'npm test -- --run',
      '--doc-update',
      'today',
      '--commit',
      'abc123',
      '--agent',
      'test-agent',
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
        actor: 'test-agent',
      },
    });
    expect(payload.item.notes).toContain(`- ${today} [test-agent]: Completed with evidence: npm test -- --run`);
    expect(payload.validation).toHaveProperty('errors');
  });

  it('history: records who changed the item and when via TENBO_AGENT, queryable via item history --json (td-030)', async () => {
    const originalEnv = process.env.TENBO_AGENT;
    process.env.TENBO_AGENT = 'alice';
    try {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      await runItemCli(dir, ['add-note', 'ed-001', 'hi', '--json']);
      stderrSpy.mockRestore();

      const result = await runItemCli(dir, ['history', 'ed-001', '--json']);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.ok).toBe(true);
      expect(payload.item_id).toBe('ed-001');
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0]).toMatchObject({ actor: 'alice', itemId: 'ed-001', operation: 'add-note' });
      expect(typeof payload.events[0].timestamp).toBe('string');
      expect(new Date(payload.events[0].timestamp).toString()).not.toBe('Invalid Date');
    } finally {
      if (originalEnv === undefined) delete process.env.TENBO_AGENT;
      else process.env.TENBO_AGENT = originalEnv;
    }
  });

  it('history: --agent flag takes precedence over TENBO_AGENT', async () => {
    const originalEnv = process.env.TENBO_AGENT;
    process.env.TENBO_AGENT = 'alice';
    try {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      await runItemCli(dir, ['add-note', 'ed-001', 'hi', '--agent', 'bob', '--json']);
      stderrSpy.mockRestore();

      const result = await runItemCli(dir, ['history', 'ed-001', '--json']);
      const payload = JSON.parse(result.stdout);
      expect(payload.events[0].actor).toBe('bob');
    } finally {
      if (originalEnv === undefined) delete process.env.TENBO_AGENT;
      else process.env.TENBO_AGENT = originalEnv;
    }
  });

  it('history: reports no journal history for an item with no recorded mutations', async () => {
    const result = await runItemCli(dir, ['history', 'ed-001', '--json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, item_id: 'ed-001', events: [] });
  });

  it('history: returns a structured not_found error for an unknown item id instead of masking the typo as empty history', async () => {
    const result = await runItemCli(dir, ['history', 'bogus-id', '--json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: 'not_found',
    });
  });

  it('returns a structured error for missing items', async () => {
    const result = await runItemCli(dir, ['show', 'ed-999', '--json']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: 'not_found',
    });
  });

  it('returns misuse exit code for unknown item commands', async () => {
    const result = await runItemCli(dir, ['unknown', 'ed-001', '--json']);

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
