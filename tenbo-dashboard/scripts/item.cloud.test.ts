import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runItemCli } from './item';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('item CLI cloud mode', () => {
  it('routes every legacy core command through cloud and never edits/falls back to YAML', async () => {
    const repo = fixtureRepo();
    const roadmapPath = path.join(repo, '.tenbo/scopes/editor/roadmap.yaml');
    const original = readFileSync(roadmapPath, 'utf8');
    vi.stubEnv('TENBO_CLOUD_API_URL', 'https://example.test/functions/v1/tenbo-api');
    vi.stubEnv('TENBO_CLOUD_PROJECT_ID', PROJECT_ID);
    vi.stubEnv('TENBO_CLOUD_AGENT_TOKEN', 'tenbo_agent_secret');
    const commands: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { command?: { kind: string; status?: string; doc_update?: string } };
      const kind = body.command?.kind ?? 'query';
      commands.push(kind);
      const status = body.command?.status ?? (kind === 'completeItem' ? 'done' : 'next');
      const item = { id: 'ed-1', title: 'Cloud item', status, description: 'cloud',
        ...(kind === 'setVerification' ? { verification: { status: body.command?.status } } : {}),
        ...(kind === 'setDocUpdate' ? { doc_update: body.command?.doc_update } : {}) };
      return new Response(JSON.stringify({ kind: 'item', value: { scope_id: 'editor', item, version: '2', archived: false } }), { status: 200 });
    }));

    const invocations = [
      ['set-status', 'ed-1', 'now'], ['add-note', 'ed-1', 'note'],
      ['verify', 'ed-1', '--status', 'verified'], ['doc-update', 'ed-1', '--date', 'today'],
      ['complete', 'ed-1', '--evidence', 'tests', '--doc-update', 'today'], ['link-commit', 'ed-1', 'abc123'],
    ];
    for (const args of invocations) expect((await runItemCli(repo, [...args, '--json'])).exitCode).toBe(0);
    expect(commands).toEqual(['setStatus', 'addNote', 'setVerification', 'setDocUpdate', 'completeItem', 'linkCommit']);
    expect(readFileSync(roadmapPath, 'utf8')).toBe(original);
    expect(existsSync(path.join(repo, '.tenbo/journal'))).toBe(false);
  });

  it.each([
    { label: 'string', notes: 'Cloud note', expectedSignal: true },
    { label: 'array', notes: ['Cloud note', 'Second note'], expectedSignal: true },
    { label: 'empty string', notes: '', expectedSignal: false },
    { label: 'empty array', notes: [], expectedSignal: false },
    { label: 'absent', notes: undefined, expectedSignal: false },
  ])('checks evidence read-only when cloud notes are $label', async ({ notes, expectedSignal }) => {
    const repo = fixtureRepo();
    vi.stubEnv('TENBO_CLOUD_API_URL', 'https://example.test/functions/v1/tenbo-api');
    vi.stubEnv('TENBO_CLOUD_PROJECT_ID', PROJECT_ID);
    vi.stubEnv('TENBO_CLOUD_AGENT_TOKEN', 'tenbo_agent_secret');
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query?: { kind: string } };
      expect(body.query?.kind).toBe('getItem');
      const item = {
        id: 'ed-1', title: 'Cloud item', status: 'next', description: 'cloud',
        ...(notes === undefined ? {} : { notes }),
      };
      return new Response(JSON.stringify({ kind: 'item', value: { scope_id: 'editor', item, version: '2', archived: false } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const result = await runItemCli(repo, ['verify', 'ed-1', '--check', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      item_id: 'ed-1',
      verdict: 'likely_open',
      signals: expectedSignal ? expect.arrayContaining(['notes']) : expect.not.arrayContaining(['notes']),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('records structured cloud verification through setVerification', async () => {
    const repo = fixtureRepo();
    vi.stubEnv('TENBO_CLOUD_API_URL', 'https://example.test/functions/v1/tenbo-api');
    vi.stubEnv('TENBO_CLOUD_PROJECT_ID', PROJECT_ID);
    vi.stubEnv('TENBO_CLOUD_AGENT_TOKEN', 'tenbo_agent_secret');
    const operations: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query?: { kind: string };
        command?: { kind: string; status?: string };
      };
      const operation = body.query?.kind ?? body.command?.kind ?? 'unknown';
      operations.push(operation);
      const item = {
        id: 'ed-1', title: 'Cloud item', status: 'next', description: 'cloud',
        done_when: [{ text: 'passing check', check: { run: 'true' } }],
        ...(body.command?.kind === 'setVerification' ? { verification: { status: body.command.status } } : {}),
      };
      return new Response(JSON.stringify({ kind: 'item', value: { scope_id: 'editor', item, version: '2', archived: false } }), { status: 200 });
    }));

    const result = await runItemCli(repo, ['verify', 'ed-1', '--check', '--agent', 'test-agent', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      passed: true,
      verification: { status: 'verified' },
    });
    expect(operations).toEqual(['getItem', 'setVerification']);
  });
});

function fixtureRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'tenbo-cloud-item-')); roots.push(repo);
  write(repo, '.tenbo/workspace.yaml', 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor\ncross_cutting: []\n');
  write(repo, '.tenbo/scopes/editor/architecture.yaml', 'layers: []\n');
  write(repo, '.tenbo/scopes/editor/roadmap.yaml', 'items:\n  - id: ed-1\n    title: Local item\n    status: next\n    description: local\n');
  return repo;
}

function write(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative); mkdirSync(path.dirname(absolute), { recursive: true }); writeFileSync(absolute, content);
}
