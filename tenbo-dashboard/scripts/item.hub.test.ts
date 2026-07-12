import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runItemCli } from './item';
import { hubHealthRoute } from '../src/api/routes/hubHealth';
import { hubMutateRoute } from '../src/api/routes/hubMutate';
import { writeHubLockfile } from '../src/api/lib/hub/lockfile';
import { readJournal } from '../src/api/lib/hub/journal';
import { maybeAutostartHub } from '../src/api/lib/hub/autostart';

// td-038 regression guard: replace maybeAutostartHub with a spy so the tests
// below can assert exactly WHERE performMutation (scripts/item.ts) calls it —
// only on the true no-hub path, never when a hub was discovered — regardless
// of vitest.config.ts's process-wide `TENBO_NO_AUTOSTART=1` (which would
// otherwise make the real function a silent no-op and hide a mis-wire where
// the call moved into the `if (hub)` branch or became unconditional).
vi.mock('../src/api/lib/hub/autostart', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/lib/hub/autostart')>();
  return { ...actual, maybeAutostartHub: vi.fn() };
});

/**
 * Live, end-to-end demonstration of td-029's CLI routing decision:
 *
 *  - "hub found" test starts a REAL http.Server wired with the same route
 *    handlers the dashboard mounts (hubHealthRoute + hubMutateRoute), writes
 *    a real lockfile pointing at it, then runs the actual CLI (`runItemCli`)
 *    against a repo scoped to that lockfile. discoverHub does a real network
 *    health-check round trip and sendHubMutation does a real POST — nothing
 *    here is mocked.
 *  - "no hub" test runs the same CLI command with no server/lockfile present
 *    and asserts the direct-write fallback + stderr notice.
 */

let dir: string;

function seedRepo(target: string) {
  mkdirSync(path.join(target, '.git'));
  mkdirSync(path.join(target, '.tenbo/scopes/editor/layers/app'), { recursive: true });
  writeFileSync(path.join(target, '.tenbo/workspace.yaml'), 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor scope\ncross_cutting: []\n');
  writeFileSync(path.join(target, '.tenbo/scopes/editor/architecture.yaml'), 'layers:\n  - id: app\n    name: App\n    description: application layer\n    files: ["src/**"]\n');
  writeFileSync(path.join(target, '.tenbo/scopes/editor/layers/app/README.md'), '# App\n');
  writeFileSync(path.join(target, '.tenbo/overview.md'), '# Overview\n');
  writeFileSync(path.join(target, '.tenbo/scopes/editor/roadmap.yaml'), [
    'items:',
    '  - id: ed-001',
    '    title: First',
    '    layer: app',
    '    status: next',
    '    description: first item',
    '',
  ].join('\n'));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-item-hub-cli-'));
  seedRepo(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('item CLI hub routing (live, td-029)', () => {
  it('routes a mutation through a live discovered hub instead of writing directly', async () => {
    let mutateHits = 0;
    const health = hubHealthRoute(dir);
    const mutate = hubMutateRoute(dir);
    const server: Server = createServer((req, res) => {
      if (req.url === '/api/hub/mutate') mutateHits += 1;
      health(req, res, () => {
        mutate(req, res, () => {
          res.statusCode = 404;
          res.end();
        });
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    // Real pid: this test process itself, so the liveness check in
    // discoverHub passes exactly as it would for a real hub process.
    writeHubLockfile(dir, port);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await runItemCli(dir, ['set-status', 'ed-001', 'done']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('ed-001 status: done\n');
      // The fallback notice must NOT be printed — this mutation went through the hub.
      expect(stderrSpy).not.toHaveBeenCalledWith('note: no tenbo hub running, writing files directly\n');
      // And the mutation route was actually hit exactly once, proving the
      // write happened via HTTP, not via a local direct roadmapStore call.
      expect(mutateHits).toBe(1);

      const roadmap = readFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'utf8');
      expect(roadmap).toContain('status: done');
    } finally {
      stderrSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('falls back to a direct write and prints the notice when no hub is running', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await runItemCli(dir, ['set-status', 'ed-001', 'done']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('ed-001 status: done\n');
      expect(stderrSpy).toHaveBeenCalledWith('note: no tenbo hub running, writing files directly\n');

      const roadmap = readFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'utf8');
      expect(roadmap).toContain('status: done');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('routes agent identity through the hub and stamps it on the note (td-030, single choke point)', async () => {
    const health = hubHealthRoute(dir);
    const mutate = hubMutateRoute(dir);
    const server: Server = createServer((req, res) => {
      health(req, res, () => {
        mutate(req, res, () => { res.statusCode = 404; res.end(); });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    writeHubLockfile(dir, port);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await runItemCli(dir, ['add-note', 'ed-001', 'hi', '--agent', 'alice', '--json']);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).item.notes).toContain('[alice]: hi');

      const events = readJournal(dir, { itemId: 'ed-001' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actor: 'alice', itemId: 'ed-001', operation: 'add-note' });
    } finally {
      stderrSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('IDEMPOTENCY: a lost hub response followed by the CLI direct-write fallback does not double-apply (td-029 follow-up, closed by td-030)', async () => {
    // The mutate route applies the mutation for real (it lands on disk AND
    // in the journal) but the HTTP response is never delivered — simulating
    // exactly the failure mode td-029 left open: hub commits, response is
    // lost, CLI falls back and retries. `performMutation` reuses the SAME
    // mutation id for both attempts, so `applyMutation`'s idempotency check
    // must make the fallback a no-op.
    const health = hubHealthRoute(dir);
    const mutate = hubMutateRoute(dir);
    const server: Server = createServer((req, res) => {
      if (req.url === '/api/hub/mutate' && req.method === 'POST') {
        const originalEnd = res.end.bind(res);
        res.end = ((..._args: unknown[]) => {
          // Mutation has already been applied & journaled by the time
          // hubMutateRoute calls res.end() to send its response — drop the
          // connection here instead of sending bytes back.
          req.socket.destroy();
          return res;
        }) as typeof res.end;
        mutate(req, res, () => { originalEnd(); });
        return;
      }
      health(req, res, () => { res.statusCode = 404; res.end(); });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    writeHubLockfile(dir, port);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await runItemCli(dir, ['add-note', 'ed-001', 'hi', '--agent', 'alice', '--json']);

      // The fallback notice DID fire — from the CLI's point of view the hub
      // attempt failed (it never got a response) — but the note was NOT
      // double-appended, because applyMutation's idempotency check saw the
      // mutation id the hub had already journaled.
      expect(stderrSpy).toHaveBeenCalledWith('note: no tenbo hub running, writing files directly\n');
      expect(result.exitCode).toBe(0);

      const roadmap = readFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'utf8');
      const hiLines = roadmap.split('\n').filter((line) => line.includes('[alice]: hi'));
      expect(hiLines).toHaveLength(1);

      const events = readJournal(dir, { itemId: 'ed-001' });
      expect(events).toHaveLength(1);
    } finally {
      stderrSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('BLOCKER regression (reviewer repro): a read-only journal directory does not fail the hub mutation, so the CLI never falls back and double-applies (td-030)', async () => {
    // This is the reviewer's LIVE repro: make `.tenbo/journal` read-only,
    // then drive a mutation through the actual CLI -> hub HTTP path (no
    // mocking). Before the fix, appendJournalEvent's throw propagated out
    // of applyMutation on the hub side, hubMutateRoute responded
    // {ok:false}, and performMutation's fallback re-applied the SAME
    // mutationId directly — but since the journal write never landed,
    // hasJournaledMutation was still false, so the note got added twice.
    const health = hubHealthRoute(dir);
    const mutate = hubMutateRoute(dir);
    const server: Server = createServer((req, res) => {
      health(req, res, () => {
        mutate(req, res, () => { res.statusCode = 404; res.end(); });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    writeHubLockfile(dir, port);

    const journalPath = path.join(dir, '.tenbo', 'journal');
    mkdirSync(journalPath, { recursive: true });
    chmodSync(journalPath, 0o500); // read+execute only — appendJournalEvent's write throws

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await runItemCli(dir, ['add-note', 'ed-001', 'hi', '--agent', 'alice', '--json']);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).item.notes).toContain('[alice]: hi');

      // The hub's FIRST attempt must have succeeded (ok:true) despite the
      // broken journal, so the CLI fallback notice must never fire — proving
      // no second, duplicate write attempt happened at all.
      expect(stderrSpy).not.toHaveBeenCalledWith('note: no tenbo hub running, writing files directly\n');

      const roadmap = readFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'utf8');
      const hiLines = roadmap.split('\n').filter((line) => line.includes('[alice]: hi'));
      expect(hiLines).toHaveLength(1); // NOT double-applied
    } finally {
      chmodSync(journalPath, 0o700);
      stderrSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('falls back cleanly when a lockfile exists but nothing is listening on its port', async () => {
    // A stale lockfile from a crashed hub: pid is this (alive) process, but
    // the port has nothing bound to it, so the health check must fail and
    // discoverHub must return null rather than hanging or throwing.
    writeHubLockfile(dir, 1); // port 1 — nothing listens there in test envs

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await runItemCli(dir, ['set-status', 'ed-001', 'done']);

      expect(result.exitCode).toBe(0);
      expect(stderrSpy).toHaveBeenCalledWith('note: no tenbo hub running, writing files directly\n');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe('item CLI hub-autostart call-site wiring (td-038 regression)', () => {
  // Scoped env override: vitest.config.ts sets TENBO_NO_AUTOSTART=1 for the
  // whole suite (see comment there). We stub it empty here so that, even
  // though maybeAutostartHub itself is mocked (bypassing its internal gate
  // entirely), the test also holds if a future refactor turns the mock into
  // a partial spy over the real implementation. Restored in afterEach so no
  // other test in the suite is affected.
  beforeEach(() => {
    vi.stubEnv('TENBO_NO_AUTOSTART', '');
    vi.mocked(maybeAutostartHub).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('calls maybeAutostartHub exactly once on the no-hub fallback path, and the write still completes', async () => {
    // No lockfile written for `dir` — discoverHub finds nothing.
    const result = await runItemCli(dir, ['set-status', 'ed-001', 'done']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ed-001 status: done\n');
    expect(maybeAutostartHub).toHaveBeenCalledTimes(1);
    expect(maybeAutostartHub).toHaveBeenCalledWith(dir);

    const roadmap = readFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'utf8');
    expect(roadmap).toContain('status: done');
  });

  it('does NOT call maybeAutostartHub when a live hub is discovered', async () => {
    const health = hubHealthRoute(dir);
    const mutate = hubMutateRoute(dir);
    const server: Server = createServer((req, res) => {
      health(req, res, () => {
        mutate(req, res, () => { res.statusCode = 404; res.end(); });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    writeHubLockfile(dir, port);

    try {
      const result = await runItemCli(dir, ['set-status', 'ed-001', 'done']);

      expect(result.exitCode).toBe(0);
      expect(maybeAutostartHub).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
