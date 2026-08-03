import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runContextCli } from './context';
import { runItemCli } from './item';
import { runItemsCli } from './items';
import { runNextCli } from './next';
import { runNextIdCli } from './next-id';
import { runWorkQueueCli } from './work-queue';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('top-level CLI cloud query routing', () => {
  it('routes items/next/queue/context/item/next-id without reading or mutating the legacy roadmap', async () => {
    const repo = fixtureRepo();
    const roadmap = path.join(repo, '.tenbo/scopes/editor/roadmap.yaml');
    const original = readFileSync(roadmap, 'utf8');
    vi.stubEnv('TENBO_CLOUD_API_URL', 'https://example.test/functions/v1/tenbo-api');
    vi.stubEnv('TENBO_CLOUD_PROJECT_ID', PROJECT_ID);
    vi.stubEnv('TENBO_CLOUD_AGENT_TOKEN', 'secret');
    const operations: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query?: { kind: string }; command?: { kind: string } };
      const operation = body.query?.kind ?? body.command?.kind ?? 'unknown'; operations.push(operation);
      if (operation === 'allocateItemId') return json({ kind: 'allocation', item_id: 'x-99' });
      if (operation === 'getItem') return json({ kind: 'item', value: itemRecord() });
      if (operation === 'getSessionContext') return json({ kind: 'context', intent: 'session', payload: { items: [itemRecord()] }, bounds: bounds() });
      return json({ kind: 'itemPage', value: { items: [itemRecord()], page: { row_count: 1, has_more: false } } });
    }));

    expect((await runItemsCli(repo, ['--json'])).exitCode).toBe(0);
    expect((await runNextCli(repo, ['--json'])).exitCode).toBe(0);
    expect((await runWorkQueueCli(repo, ['--json'])).exitCode).toBe(0);
    expect((await runContextCli(repo, ['session', '--json'])).exitCode).toBe(0);
    expect((await runItemCli(repo, ['show', 'ed-1', '--json'])).exitCode).toBe(0);
    expect(await runNextIdCli(repo, 'x')).toBe('x-99');
    expect(operations).toEqual(['listItems', 'getWorkQueue', 'listItems', 'getSessionContext', 'getItem', 'allocateItemId']);
    expect(readFileSync(roadmap, 'utf8')).toBe(original);
  });
});

function fixtureRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'tenbo-cloud-routing-')); roots.push(repo);
  write(repo, '.tenbo/workspace.yaml', 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor\ncross_cutting: []\n');
  write(repo, '.tenbo/scopes/editor/architecture.yaml', 'layers: []\n');
  write(repo, '.tenbo/scopes/editor/roadmap.yaml', 'items: [malformed legacy bytes that cloud mode must not parse\n');
  return repo;
}

function itemRecord() {
  return { scope_id: 'editor', item: { id: 'ed-1', title: 'Cloud', status: 'next', description: 'cloud' }, version: '1', archived: false };
}

function bounds() {
  return { row_count: 1, byte_count: 100, token_estimate: 25, estimator: 'tenbo-token-estimator-v1', limits: { rows: 16, bytes: 24576, tokens: 1500 }, truncated: false };
}

function json(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200 }); }

function write(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative); mkdirSync(path.dirname(absolute), { recursive: true }); writeFileSync(absolute, content);
}
