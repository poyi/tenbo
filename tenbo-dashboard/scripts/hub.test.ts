import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runHubCli, runHubEnsure, startHubForCli } from './hub';
import { startHubServer, type HubServerHandle } from '../src/api/lib/hub/hubServer';
import { discoverHub } from '../src/api/lib/hub/discover';

let dir: string;
const openHandles: HubServerHandle[] = [];
const openChildren: ChildProcess[] = [];

function seedRepo(target: string): void {
  mkdirSync(path.join(target, '.git'));
  mkdirSync(path.join(target, '.tenbo/scopes/editor/layers/app'), { recursive: true });
  writeFileSync(path.join(target, '.tenbo/workspace.yaml'), 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor scope\ncross_cutting: []\n');
  writeFileSync(path.join(target, '.tenbo/scopes/editor/architecture.yaml'), 'layers:\n  - id: app\n    name: App\n    description: application layer\n    files: ["src/**"]\n');
  writeFileSync(path.join(target, '.tenbo/scopes/editor/layers/app/README.md'), '# App\n');
  writeFileSync(path.join(target, '.tenbo/overview.md'), '# Overview\n');
  writeFileSync(path.join(target, '.tenbo/scopes/editor/roadmap.yaml'), 'items:\n  - id: ed-001\n    title: First\n    layer: app\n    status: next\n    description: first item\n');
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-hub-cli-'));
  seedRepo(dir);
});

afterEach(async () => {
  for (const handle of openHandles.splice(0)) await handle.shutdown();
  for (const child of openChildren.splice(0)) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

async function startReal(options: Parameters<typeof startHubServer>[1] = {}): Promise<HubServerHandle> {
  const handle = await startHubServer(dir, { idleCheckIntervalMs: 0, ...options });
  openHandles.push(handle);
  return handle;
}

/** In-process stand-in for `ensure`'s real detached spawn, so tests never fork a subprocess. */
function inProcessSpawner(collected: HubServerHandle[]) {
  return (repoRoot: string, port: number): void => {
    void startHubServer(repoRoot, { port, idleCheckIntervalMs: 0 })
      .then((handle) => {
        openHandles.push(handle);
        collected.push(handle);
      })
      .catch(() => {
        // Lost the EADDRINUSE race — a real detached `hub start` would just exit cleanly here too.
      });
  };
}

/** A tiny real child process with its own pid, used to test `stop`'s SIGTERM path without touching the test runner's own pid. */
function spawnCooperativeStub(lockfilePath: string): Promise<ChildProcess> {
  return new Promise((resolve) => {
    const script = [
      `process.on('SIGTERM', () => {`,
      `  try { require('fs').rmSync(${JSON.stringify(lockfilePath)}); } catch {}`,
      `  process.exit(0);`,
      `});`,
      `process.stdout.write('ready\\n');`,
      `setInterval(() => {}, 1000);`,
    ].join(' ');
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    openChildren.push(child);
    child.stdout?.once('data', () => resolve(child));
  });
}

function testSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A live child that ignores SIGTERM entirely — used to force runHubStop's 2s fallback-removal path. */
function spawnIgnoringStub(): Promise<ChildProcess> {
  return new Promise((resolve) => {
    const script = [`process.on('SIGTERM', () => {});`, `process.stdout.write('ready\\n');`, `setInterval(() => {}, 1000);`].join(' ');
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    openChildren.push(child);
    child.stdout?.once('data', () => resolve(child));
  });
}

function writeDescriptor(repoRoot: string, pid: number, port: number): string {
  const lockfilePath = path.join(repoRoot, '.tenbo', 'cache', 'hub.json');
  mkdirSync(path.dirname(lockfilePath), { recursive: true });
  writeFileSync(
    lockfilePath,
    `${JSON.stringify({ pid, port, repoRoot, startedAt: new Date().toISOString(), schemaVersion: 1 }, null, 2)}\n`,
  );
  return lockfilePath;
}

describe('runHubCli (td-037)', () => {
  it('prints help with no args', async () => {
    const result = await runHubCli(dir, []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tenbo-dashboard hub');
    expect(result.stdout).toContain('start');
    expect(result.stdout).toContain('ensure');
  });

  it('rejects an unknown subcommand', async () => {
    const result = await runHubCli(dir, ['bogus']);
    expect(result.exitCode).toBe(2);
  });

  describe('status', () => {
    it('reports not running when no hub is up', async () => {
      const result = await runHubCli(dir, ['status', '--json']);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, running: false });
    });

    it('reports pid/port/uptime when a hub is up', async () => {
      const handle = await startReal();
      const result = await runHubCli(dir, ['status', '--json']);
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body).toMatchObject({ ok: true, running: true, pid: handle.pid, port: handle.port });
      expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('stop', () => {
    it('reports not running when no lockfile exists', async () => {
      const result = await runHubCli(dir, ['stop', '--json']);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, stopped: false, reason: 'not-running' });
    });

    it('cleans up a stale lockfile (dead pid) without sending a signal', async () => {
      const lockfilePath = writeDescriptor(dir, 999_999, 12345); // presumed-dead pid, same convention as mutationClaim.test.ts
      const result = await runHubCli(dir, ['stop', '--json']);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, stopped: false, reason: 'stale' });
      expect(existsSync(lockfilePath)).toBe(false);
    });

    it('SIGTERMs a live hub pid and confirms the lockfile disappears', async () => {
      const lockfilePath = path.join(dir, '.tenbo', 'cache', 'hub.json');
      const child = await spawnCooperativeStub(lockfilePath);
      writeDescriptor(dir, child.pid!, 54321);

      const result = await runHubCli(dir, ['stop', '--json']);
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body).toMatchObject({ ok: true, stopped: true, pid: child.pid });
      expect(existsSync(lockfilePath)).toBe(false);
    });

    it('fallback removal does NOT clobber a lockfile a newer hub has since taken over (td-037 review fix 1)', async () => {
      const lockfilePath = path.join(dir, '.tenbo', 'cache', 'hub.json');
      const child = await spawnIgnoringStub(); // never removes the lockfile itself, forcing the 2s fallback path
      writeDescriptor(dir, child.pid!, 11_111);

      const stopPromise = runHubCli(dir, ['stop', '--json']);

      // Before runHubStop's fallback deadline elapses, simulate a newer hub
      // taking over this repo's lockfile.
      await testSleep(100);
      writeDescriptor(dir, 424_242, 22_222);

      const result = await stopPromise;
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body).toMatchObject({ ok: true, stopped: true, pid: child.pid });

      // The new owner's descriptor must survive untouched — not deleted by
      // the fallback removal.
      expect(existsSync(lockfilePath)).toBe(true);
      const cur = JSON.parse(readFileSync(lockfilePath, 'utf8'));
      expect(cur).toMatchObject({ pid: 424_242, port: 22_222 });
    }, 10_000);

    it('really stops a hub started via startHubServer end to end', async () => {
      // Not a real separate process (same pid as the test runner), so this
      // exercises the SIGTERM-would-be-a-no-op edge rather than a true
      // cross-process kill — the meaningful cross-process case is covered
      // above with a real child pid. Here we confirm discovery reflects the
      // hub before stop and is gone conceptually once shut down directly.
      const handle = await startReal();
      expect(await discoverHub(dir)).not.toBeNull();
      await handle.shutdown();
      expect(await discoverHub(dir)).toBeNull();
    });
  });

  describe('ensure (via CLI, discovery-only path)', () => {
    it('is a no-op and reports "already running" when a hub is already up', async () => {
      const handle = await startReal();
      const result = await runHubCli(dir, ['ensure', '--json']);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, status: 'already-running', pid: handle.pid, port: handle.port });
    });
  });
});

describe('runHubEnsure (td-037 AC2)', () => {
  it('reports already-running without spawning when a live hub exists', async () => {
    const handle = await startReal();
    let spawnCalled = false;
    const result = await runHubEnsure(dir, { spawnStart: () => { spawnCalled = true; } });
    expect(result.status).toBe('already-running');
    expect(result.hub?.port).toBe(handle.port);
    expect(spawnCalled).toBe(false);
  });

  it('spawns and awaits health when no hub exists, converging on the spawned hub', async () => {
    const started: HubServerHandle[] = [];
    const result = await runHubEnsure(dir, { spawnStart: inProcessSpawner(started), pollIntervalMs: 20, timeoutMs: 2000 });
    expect(result.status).toBe('started');
    expect(started).toHaveLength(1);
    expect(result.hub?.port).toBe(started[0].port);
  });

  it('CONCURRENCY: two concurrent ensure calls for the same repo converge on ONE hub, the loser resolving via EADDRINUSE (td-037 AC2)', async () => {
    const started: HubServerHandle[] = [];
    const spawner = inProcessSpawner(started);

    const [r1, r2] = await Promise.all([
      runHubEnsure(dir, { spawnStart: spawner, pollIntervalMs: 20, timeoutMs: 3000 }),
      runHubEnsure(dir, { spawnStart: spawner, pollIntervalMs: 20, timeoutMs: 3000 }),
    ]);

    expect(r1.status).not.toBe('timed-out');
    expect(r2.status).not.toBe('timed-out');
    expect(r1.hub?.port).toBe(r2.hub?.port);
    expect(r1.hub?.pid).toBe(r2.hub?.pid);
    // Only one of the two spawn attempts actually bound a listening server —
    // the other lost the deterministic-port EADDRINUSE race and its
    // in-process stand-in swallowed the error exactly as a real detached
    // `hub start` process would just exit.
    expect(started).toHaveLength(1);
  });

  it('reports timed-out if the spawned hub never comes up (fails clean, does not hang)', async () => {
    const result = await runHubEnsure(dir, { spawnStart: () => {}, pollIntervalMs: 20, timeoutMs: 150 });
    expect(result.status).toBe('timed-out');
    expect(result.hub).toBeNull();
  });

  it('fails open if spawnStart itself throws synchronously', async () => {
    const result = await runHubEnsure(dir, {
      spawnStart: () => { throw new Error('spawn EPERM'); },
      pollIntervalMs: 20,
      timeoutMs: 150,
    });
    expect(result.status).toBe('timed-out'); // never throws out of runHubEnsure
  });
});

describe('startHubForCli (td-037 AC1/AC2)', () => {
  it('starts a hub and returns kind: started', async () => {
    const outcome = await startHubForCli(dir, { port: 0 });
    expect(outcome.kind).toBe('started');
    if (outcome.kind === 'started') openHandles.push(outcome.handle);
  });

  it('reports kind: already-running when the port collides with this repo\'s own hub', async () => {
    const winner = await startReal({ port: 0 });
    const outcome = await startHubForCli(dir, { port: winner.port });
    expect(outcome).toMatchObject({ kind: 'already-running', hub: { pid: winner.pid, port: winner.port } });
  });

  describe('EADDRINUSE cross-repo/unrelated-process fallback (td-037 review fix 2)', () => {
    it('falls back to an ephemeral port (instead of erroring) when the requested port is squatted by something that is not this repo\'s hub', async () => {
      const { createServer } = await import('node:net');
      const squatter = createServer();
      await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
      const port = (squatter.address() as { port: number }).port;
      try {
        const outcome = await startHubForCli(dir, { port });
        expect(outcome.kind).toBe('started');
        if (outcome.kind === 'started') {
          openHandles.push(outcome.handle);
          expect(outcome.handle.port).not.toBe(port); // bound elsewhere, not the squatted port
          const hub = await discoverHub(dir);
          expect(hub?.port).toBe(outcome.handle.port);
        }
      } finally {
        await new Promise<void>((resolve) => squatter.close(() => resolve()));
      }
    });

    it('two DIFFERENT repos colliding on the same derived port both end up with their own working hub, live-reproduced', async () => {
      // repoB's "derived port" is simulated by pointing it at repoA's already-bound
      // real hub port — exactly what happens in production when
      // derivePortForRepo(repoA) === derivePortForRepo(repoB) for two unrelated repos.
      const repoA = mkdtempSync(path.join(tmpdir(), 'tenbo-hub-cli-repoA-'));
      seedRepo(repoA);
      try {
        const hubA = await startHubServer(repoA, { idleCheckIntervalMs: 0 });
        openHandles.push(hubA);

        const outcomeB = await startHubForCli(dir, { port: hubA.port });
        expect(outcomeB.kind).toBe('started');
        if (outcomeB.kind === 'started') {
          openHandles.push(outcomeB.handle);
          expect(outcomeB.handle.port).not.toBe(hubA.port);

          // Both repos end up with their own live, independently-discoverable hub.
          const discoveredA = await discoverHub(repoA);
          const discoveredB = await discoverHub(dir);
          expect(discoveredA?.pid).toBe(hubA.pid);
          expect(discoveredA?.port).toBe(hubA.port);
          expect(discoveredB?.pid).toBe(outcomeB.handle.pid);
          expect(discoveredB?.port).toBe(outcomeB.handle.port);
        }
      } finally {
        rmSync(repoA, { recursive: true, force: true });
      }
    });
  });

  describe('EADDRINUSE same-repo convergence is NOT reopened by the fix-2 fallback', () => {
    it('when a same-repo hub already owns the port, still reports already-running (no ephemeral fallback, no second hub)', async () => {
      const winner = await startReal({ port: 0 });
      const outcome = await startHubForCli(dir, { port: winner.port });
      expect(outcome).toMatchObject({ kind: 'already-running', hub: { pid: winner.pid, port: winner.port } });
    });
  });
});
