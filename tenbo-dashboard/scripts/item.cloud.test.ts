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
