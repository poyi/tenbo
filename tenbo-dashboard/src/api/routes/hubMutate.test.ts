import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { hubMutateRoute } from './hubMutate';
import { findItem } from '../lib/roadmapStore';
import type { MutationOp, MutationRequest } from '../lib/hub/mutations';
import { claimFilePathForTest, HUB_CLAIM_MAX_WAIT_MS } from '../lib/hub/mutationClaim';

let dir: string;
let server: Server;
let baseUrl: string;

function itemFixture(id: string, index: number): string {
  return [
    `  - id: ${id}`,
    `    title: Item ${index}`,
    '    layer: app',
    '    status: next',
    `    description: item number ${index}`,
  ].join('\n');
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-hub-mutate-route-'));
  mkdirSync(path.join(dir, '.git'));
  mkdirSync(path.join(dir, '.tenbo/scopes/editor/layers/app'), { recursive: true });
  writeFileSync(path.join(dir, '.tenbo/workspace.yaml'), 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor scope\ncross_cutting: []\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/architecture.yaml'), 'layers:\n  - id: app\n    name: App\n    description: application layer\n    files: ["src/**"]\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/README.md'), '# App\n');
  writeFileSync(path.join(dir, '.tenbo/overview.md'), '# Overview\n');

  const ids = Array.from({ length: 10 }, (_, i) => `ed-${String(i + 1).padStart(3, '0')}`);
  writeFileSync(
    path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'),
    ['items:', ...ids.map((id, i) => itemFixture(id, i)), ''].join('\n'),
  );

  const handler = hubMutateRoute(dir);
  server = createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function postMutation(req: MutationOp & { mutationId?: string; agent?: string }): Promise<Response> {
  const full: MutationRequest = { mutationId: randomUUID(), agent: 'test-agent', ...req } as MutationRequest;
  return fetch(`${baseUrl}/api/hub/mutate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(full),
  });
}

describe('POST /api/hub/mutate', () => {
  it('applies a single mutation and returns the updated item', async () => {
    const res = await postMutation({ op: 'set-status', itemId: 'ed-001', status: 'done' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, scope: 'editor', item: { id: 'ed-001', status: 'done' } });
  });

  it('returns a structured {ok:false} error envelope for an unknown item, matching the CLI fail() shape', async () => {
    const res = await postMutation({ op: 'set-status', itemId: 'ed-999', status: 'done' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('returns a 400 with invalid_status for a bad status value', async () => {
    const res = await postMutation({ op: 'set-status', itemId: 'ed-001', status: 'not-a-real-status' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: 'invalid_status' });
  });

  it(
    'CONCURRENCY: N concurrent set-status mutations to distinct items all land with no lost update',
    async () => {
      const ids = Array.from({ length: 10 }, (_, i) => `ed-${String(i + 1).padStart(3, '0')}`);

      const responses = await Promise.all(
        ids.map((id) => postMutation({ op: 'set-status', itemId: id, status: 'done' })),
      );

      for (const res of responses) expect(res.status).toBe(200);

      for (const id of ids) {
        const located = findItem(dir, id);
        expect(located.item.status).toBe('done');
      }
    },
  );

  it(
    'CONCURRENCY: N concurrent add-note mutations to the SAME item all land — no lost updates from racing read-modify-write',
    async () => {
      const N = 15;
      const notes = Array.from({ length: N }, (_, i) => `concurrent note ${i}`);

      const responses = await Promise.all(
        notes.map((note) => postMutation({ op: 'add-note', itemId: 'ed-001', note })),
      );

      for (const res of responses) expect(res.status).toBe(200);

      const roadmapText = readFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'utf8');
      for (const note of notes) {
        expect(roadmapText).toContain(note);
      }
      // Every note landed on its own line — none silently overwrote another.
      const noteLines = notes.filter((note) => roadmapText.includes(note));
      expect(noteLines).toHaveLength(N);

      const located = findItem(dir, 'ed-001');
      for (const note of notes) {
        expect(located.item.notes).toContain(note);
      }
    },
  );

  it(
    "HUB EVENT LOOP (review follow-up to td-034): a claim held by a live, never-journaling external claimant resolves within the hub's small claim budget over real HTTP, not the CLI fallback's ~1s default",
    async () => {
      const mutationId = 'mut-hub-budget-wiring';
      // Pre-seed a claim as if another actor (e.g. the CLI's own
      // direct-write fallback racing this exact mutationId, per td-034's
      // motivating scenario) already owns it — alive (this process's own
      // pid, which is genuinely alive) and fresh (not stale), and it never
      // journals, so the hub's poll loop is guaranteed to run out its full
      // wait budget rather than short-circuiting on an early poll.
      const claimPath = claimFilePathForTest(dir, mutationId);
      mkdirSync(path.dirname(claimPath), { recursive: true });
      writeFileSync(claimPath, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }), { flag: 'wx' });

      const started = Date.now();
      const res = await postMutation({ op: 'add-note', itemId: 'ed-001', note: 'hub budget race', mutationId });
      const elapsedMs = Date.now() - started;

      // Fails open (claimant alive, not stale, never journaled) and still
      // applies — same as the CLI's 1s budget would, but this proves the
      // REAL route wiring (routes/hubMutate.ts's HUB_CLAIM_OPTIONS), not
      // just applyMutation called directly, uses the small hub budget: well
      // under the CLI fallback's 1000ms default, generously bounded here to
      // tolerate CI scheduling jitter.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, item: { id: 'ed-001' } });
      expect(elapsedMs).toBeLessThan(600); // well under the 1000ms CLI-fallback default
      expect(elapsedMs).toBeGreaterThanOrEqual(HUB_CLAIM_MAX_WAIT_MS - 20); // did genuinely wait out ~the hub budget, not return instantly
    },
  );
});
