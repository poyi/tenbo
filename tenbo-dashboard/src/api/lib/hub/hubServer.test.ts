import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startHubServer, derivePortForRepo, HubPortInUseError, type HubServerHandle } from './hubServer';
import { discoverHub } from './discover';
import { readHubLockfile } from './lockfile';

let dir: string;
const openHandles: HubServerHandle[] = [];

function seedRepo(target: string): void {
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
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-hub-server-'));
  seedRepo(dir);
});

afterEach(async () => {
  for (const handle of openHandles.splice(0)) {
    await handle.shutdown();
  }
  rmSync(dir, { recursive: true, force: true });
});

async function start(options: Parameters<typeof startHubServer>[1] = {}): Promise<HubServerHandle> {
  const handle = await startHubServer(dir, { idleCheckIntervalMs: 0, ...options });
  openHandles.push(handle);
  return handle;
}

describe('startHubServer (td-037)', () => {
  it('boots a plain node:http server (no Vite) bound to an ephemeral port and writes the lockfile', async () => {
    const handle = await start();
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.pid).toBe(process.pid);

    const lockfile = readHubLockfile(dir);
    expect(lockfile).not.toBeNull();
    expect(lockfile?.port).toBe(handle.port);
    expect(lockfile?.pid).toBe(process.pid);
  });

  it('a headless-written lockfile is discovered by discoverHub, same as the full dashboard writes (parity)', async () => {
    const handle = await start();
    const hub = await discoverHub(dir);
    expect(hub).not.toBeNull();
    expect(hub?.port).toBe(handle.port);
    expect(hub?.pid).toBe(process.pid);
  });

  it('serves GET /api/hub/health', async () => {
    const handle = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/hub/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, pid: process.pid });
  });

  it('serves POST /api/hub/mutate by reusing the SAME hubMutateRoute handler as the full dashboard', async () => {
    const handle = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/hub/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutationId: randomUUID(), agent: 'test', op: 'set-status', itemId: 'ed-001', status: 'done' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, item: { id: 'ed-001', status: 'done' } });

    const roadmap = readFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'utf8');
    expect(roadmap).toContain('status: done');
  });

  it('404s any other path', async () => {
    const handle = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/not-a-hub-route`);
    expect(res.status).toBe(404);
  });

  it('shutdown removes the lockfile and closes the server (fetch then fails)', async () => {
    const handle = await start();
    expect(readHubLockfile(dir)).not.toBeNull();
    await handle.shutdown();
    expect(readHubLockfile(dir)).toBeNull();
    await expect(fetch(`http://127.0.0.1:${handle.port}/api/hub/health`)).rejects.toThrow();
  });

  it('shutdown is idempotent (safe to call twice)', async () => {
    const handle = await start();
    await handle.shutdown();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('shutdown does NOT remove the lockfile if ownership has since changed (td-037 review fix 1)', async () => {
    const handle = await start();
    expect(readHubLockfile(dir)).not.toBeNull();

    // Simulate another hub having since taken over this repo's lockfile
    // (e.g. this handle was the loser of a start race and its idle timer or
    // SIGTERM handler is only now getting around to calling shutdown()).
    const lockfilePath = path.join(dir, '.tenbo/cache/hub.json');
    const takenOver = { pid: 999_999, port: 54_321, repoRoot: dir, startedAt: new Date().toISOString(), schemaVersion: 1 };
    writeFileSync(lockfilePath, `${JSON.stringify(takenOver, null, 2)}\n`);

    await handle.shutdown();

    const cur = readHubLockfile(dir);
    expect(cur).not.toBeNull();
    expect(cur?.pid).toBe(999_999);
    expect(cur?.port).toBe(54_321);
  });

  describe('EADDRINUSE (concurrent start collision)', () => {
    it('rejects with HubPortInUseError when the requested port is already bound, without disturbing the winner\'s lockfile', async () => {
      const winner = await start({ port: 0 });
      await expect(start({ port: winner.port })).rejects.toBeInstanceOf(HubPortInUseError);

      // Winner's lockfile is untouched and still discoverable — "no clobbered
      // lockfile, winner's lockfile is discoverable" (td-037 AC2).
      const hub = await discoverHub(dir);
      expect(hub?.port).toBe(winner.port);
      expect(hub?.pid).toBe(winner.pid);
    });

    it('the loser never binds a listening server (no duplicate hub)', async () => {
      const winner = await start({ port: 0 });
      let loserErr: unknown;
      try {
        await start({ port: winner.port });
      } catch (err) {
        loserErr = err;
      }
      expect(loserErr).toBeInstanceOf(HubPortInUseError);
      expect((loserErr as HubPortInUseError).port).toBe(winner.port);
    });
  });

  describe('derivePortForRepo', () => {
    it('is deterministic for the same repo root', () => {
      expect(derivePortForRepo(dir)).toBe(derivePortForRepo(dir));
    });

    it('falls in the documented [20000, 40000) range', () => {
      const port = derivePortForRepo(dir);
      expect(port).toBeGreaterThanOrEqual(20000);
      expect(port).toBeLessThan(40000);
    });

    it('differs across different repos (overwhelmingly likely, not guaranteed)', () => {
      const other = mkdtempSync(path.join(tmpdir(), 'tenbo-hub-server-other-'));
      mkdirSync(path.join(other, '.git'));
      try {
        expect(derivePortForRepo(dir)).not.toBe(derivePortForRepo(other));
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  });

  describe('idle shutdown (deterministic, injected clock — no real sleeping)', () => {
    it('checkIdle is a no-op before idleMs has elapsed', async () => {
      let now = 1_000_000;
      const handle = await start({ idleMs: 5000, now: () => now });
      expect(await handle.checkIdle()).toBe(false);
      now += 4000;
      expect(await handle.checkIdle()).toBe(false);
      expect(readHubLockfile(dir)).not.toBeNull();
    });

    it('checkIdle shuts down and removes the lockfile once idleMs has elapsed with no activity', async () => {
      let now = 1_000_000;
      const handle = await start({ idleMs: 5000, now: () => now });
      now += 6000;
      expect(await handle.checkIdle()).toBe(true);
      expect(existsSync(path.join(dir, '.tenbo/cache/hub.json'))).toBe(false);
    });

    it('calls onIdleShutdown exactly once when idle-shutdown actually fires', async () => {
      let now = 1_000_000;
      let calls = 0;
      const handle = await start({ idleMs: 5000, now: () => now, onIdleShutdown: () => { calls += 1; } });
      now += 6000;
      await handle.checkIdle();
      await handle.checkIdle(); // already closed — must not fire again
      expect(calls).toBe(1);
    });

    it('a live request under /api/hub/* resets the idle clock (activity tracking)', async () => {
      let now = 1_000_000;
      const handle = await start({ idleMs: 5000, now: () => now });

      now += 4000; // near the edge, but...
      await fetch(`http://127.0.0.1:${handle.port}/api/hub/health`); // ...touches activity using the injected clock
      expect(handle.getLastActivityAt()).toBe(now);

      now += 4000; // only 4000ms since the touch above — still under idleMs
      expect(await handle.checkIdle()).toBe(false);

      now += 2000; // now 6000ms since the touch — over idleMs
      expect(await handle.checkIdle()).toBe(true);
    });
  });
});
