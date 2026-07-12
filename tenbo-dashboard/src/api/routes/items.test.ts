import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { itemsRoute } from './items';
import { hubMutateRoute } from './hubMutate';
import { findItem } from '../lib/roadmapStore';
import { enqueueMutation } from '../lib/hub/mutationQueue';
import type { MutationOp, MutationRequest } from '../lib/hub/mutations';

let dir: string;
let server: Server;
let baseUrl: string;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-items-route-'));
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

  // Mount BOTH the UI PATCH route and the hub mutation route on the SAME
  // server, exactly as plugin.ts does in production — this is what makes
  // them share the one process-wide `enqueueMutation` queue (a module-level
  // singleton), which is the thing td-033 is about.
  const items = itemsRoute(dir);
  const hubMutate = hubMutateRoute(dir);
  server = createServer((req, res) => {
    items(req, res, () => {
      hubMutate(req, res, () => {
        res.statusCode = 404;
        res.end();
      });
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

function patchItemRequest(itemId: string, patch: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'editor', patch }),
  });
}

function postMutation(req: MutationOp & { mutationId?: string; agent?: string }): Promise<Response> {
  const full: MutationRequest = { mutationId: randomUUID(), agent: 'test-agent', ...req } as MutationRequest;
  return fetch(`${baseUrl}/api/hub/mutate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(full),
  });
}

describe('PATCH /api/items/:id', () => {
  it('still returns the canonical updated item (request/response contract unchanged)', async () => {
    const res = await patchItemRequest('ed-001', { title: 'Renamed' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, item: { id: 'ed-001', title: 'Renamed' } });
  });

  it(
    'SERIALIZATION: a UI PATCH waits behind work already queued on the shared mutation queue (td-033)',
    async () => {
      // Directly enqueue a slow task on the SAME singleton queue the routes
      // use (mutationQueue.ts's `tail` is a module-level singleton, so this
      // is indistinguishable from a slow hub mutation already in flight).
      // If the UI PATCH route did NOT route through `enqueueMutation`, its
      // response would race ahead of this slow task; since it does, the
      // PATCH response can only land after the slow task's queued turn
      // finishes.
      const order: string[] = [];
      const slow = enqueueMutation(async () => {
        await delay(150);
        order.push('slow-queued-task');
      });

      // Fire the PATCH request only after the slow task has been enqueued
      // (mirroring "already in flight" — the point under test is arrival
      // order at the queue, not raw request timing).
      const patchPromise = patchItemRequest('ed-002', { title: 'Queued after slow task' }).then((res) => {
        order.push('ui-patch-response');
        return res;
      });

      const [, res] = await Promise.all([slow, patchPromise]);
      expect(res.status).toBe(200);
      expect(order).toEqual(['slow-queued-task', 'ui-patch-response']);

      const located = findItem(dir, 'ed-002');
      expect(located.item.title).toBe('Queued after slow task');
    },
  );

  it(
    'CONCURRENCY: concurrent UI PATCHes and hub add-note mutations to the SAME item all land — no lost updates',
    async () => {
      const N = 8;
      const notes = Array.from({ length: N }, (_, i) => `hub note ${i}`);
      const titles = Array.from({ length: N }, (_, i) => `ui title ${i}`);

      const responses = await Promise.all([
        ...notes.map((note) => postMutation({ op: 'add-note', itemId: 'ed-003', note })),
        ...titles.map((title) => patchItemRequest('ed-003', { title })),
      ]);

      for (const res of responses) expect(res.status).toBe(200);

      // Every hub add-note note landed — none were silently dropped by a
      // UI PATCH's read-modify-write racing the hub's.
      const located = findItem(dir, 'ed-003');
      for (const note of notes) {
        expect(located.item.notes).toContain(note);
      }

      // The final title is one of the UI PATCH's values (last-write-wins is
      // expected for a full-field overwrite of the same key from multiple
      // concurrent callers — the point under test is that it's a WHOLE,
      // valid value, not a torn/corrupted write).
      expect(titles).toContain(located.item.title);

      // The roadmap file itself stays well-formed — every other item is
      // still present and parseable.
      const roadmapText = readFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'utf8');
      for (let i = 1; i <= 10; i += 1) {
        expect(roadmapText).toContain(`ed-${String(i).padStart(3, '0')}`);
      }
    },
  );

  it('returns an error response for an unknown item id (unchanged pre-existing behavior)', async () => {
    // patchSeqItem throws when the id isn't found in the roadmap; that
    // propagates through enqueueMutation to withErrorHandling's 500 handler,
    // exactly as it did before td-033 (this route never had a typed 404 for
    // "no such item" — only for the item disappearing between the write and
    // the post-write read-back, which is a different, narrower case).
    const res = await patchItemRequest('ed-999', { title: 'nope' });
    expect(res.status).toBe(500);
  });
});
