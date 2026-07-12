/**
 * hub.ts — thin CLI over the headless hub server (hubServer.ts). td-037,
 * Phase 1 of x-006 (see docs/superpowers/specs/2026-07-12-hub-autostart-design.md).
 *
 * `start`/`ensure`/`stop`/`status` are all here; the actual server logic
 * (binding, lockfile, idle-shutdown) lives in
 * src/api/lib/hub/hubServer.ts — this file only parses argv, calls into
 * that Data Layer, and formats output. `start` is the one subcommand that
 * doesn't fit the rest of this repo's synchronous "return a CliResult, then
 * exit" CLI pattern (see cliResult.ts) because it must keep the process
 * alive as a server — so it's handled by its own async function
 * (`runHubStartMain`), wired directly in the `isMain` block below rather
 * than through `runHubCli`.
 */

import { mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverHub, isProcessAlive } from '../src/api/lib/hub/discover';
import { readHubLockfile, removeHubLockfile, type HubDescriptor } from '../src/api/lib/hub/lockfile';
import {
  startHubServer,
  derivePortForRepo,
  HubPortInUseError,
  type HubServerHandle,
} from '../src/api/lib/hub/hubServer';
import { hasFlag, readOption } from './cliArgs';
import { fail, handleCliError, isMain, ok, misuse, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

const HELP_TEXT = `tenbo-dashboard hub — headless coordination server for concurrent agent writes (td-037)

Usage:
  tenbo-dashboard hub start [--port <n>]  Run a minimal API-only hub server in
                                           the foreground (health+mutate only —
                                           no Vite, no browser UI). Binds an
                                           ephemeral port unless --port is given.
                                           Exits if the port is already taken by
                                           another process; reports and exits 0
                                           if it's already this repo's hub.
  tenbo-dashboard hub ensure [--json]     Idempotent: no-op if a hub is already
                                           running for this repo; otherwise spawns
                                           one detached and waits (bounded) for it
                                           to come up.
  tenbo-dashboard hub stop [--json]       Stop this repo's running hub, if any.
  tenbo-dashboard hub status [--json]     Report whether a hub is running
                                           (pid/port/uptime).

Env:
  TENBO_HUB_IDLE_MS           idle-shutdown timeout in ms (default 900000 = 15 min)
  TENBO_HUB_ENSURE_TIMEOUT_MS bound on how long 'ensure' waits for a spawned
                               hub to come up (default 5000)
  TENBO_NO_AUTOSTART          set (any non-empty value) to disable lazy
                               hub autostart on the first mutating write
                               (see 'item' commands); direct writes still
                               work, just without an auto-started hub (td-038)
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TENBO_HUB_ENSURE_TIMEOUT_MS;
  if (!raw) return 5000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
}

function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// ---------------------------------------------------------------------------
// start (as a pure outcome — no process.exit/stdio here, so it's unit testable)
// ---------------------------------------------------------------------------

export type HubStartOutcome =
  | { kind: 'started'; handle: HubServerHandle }
  | { kind: 'already-running'; hub: HubDescriptor }
  | { kind: 'error'; message: string };

export interface StartHubForCliOptions {
  port?: number;
  onIdleShutdown?: () => void;
}

/**
 * Attempt to start the hub. Checks discovery FIRST so a plain sequential
 * `hub start` while a hub is already running for this repo reports
 * 'already-running' and never binds a second server (avoiding an orphaned
 * duplicate hub that would otherwise sit idle until its own idle-shutdown —
 * `start` itself doesn't get `ensure`'s deterministic-port race protection,
 * so this upfront check is what keeps the common, non-racing case clean).
 * For the residual true-race window (two `start`s landing at the same
 * instant), if the requested/default port still turns out to be taken by
 * the time we bind, `HubPortInUseError` is caught below and re-checked
 * against discovery once more — distinguishing "someone else just won this
 * repo's hub" (clean, expected) from "something unrelated is squatting the
 * port" (another repo's hub, or an unrelated process — falls back to an
 * ephemeral port; see the fallback branch below, td-037 review fix 2).
 */
export async function startHubForCli(repoRoot: string, options: StartHubForCliOptions = {}): Promise<HubStartOutcome> {
  const existing = await discoverHub(repoRoot);
  if (existing) return { kind: 'already-running', hub: existing };

  const onIdleShutdown = options.onIdleShutdown ? () => options.onIdleShutdown?.() : undefined;

  try {
    const handle = await startHubServer(repoRoot, { port: options.port, onIdleShutdown });
    return { kind: 'started', handle };
  } catch (err) {
    if (err instanceof HubPortInUseError) {
      const hub = await discoverHub(repoRoot);
      if (hub) return { kind: 'already-running', hub };

      // No hub for THIS repo owns the (derived) port — it's squatted by
      // something else: another repo's legitimate hub (two different repos
      // can hash to the same derivePortForRepo value — see hubServer.ts), or
      // an unrelated process. td-037 review fix 2: retry on a true
      // OS-assigned ephemeral port instead of failing/timing out. Same-repo
      // racers never reach this branch — they resolve via the discoverHub
      // check just above, which is what keeps them converging on ONE hub
      // (do not fall back to ephemeral for THAT case, or it would reopen the
      // two-hubs-for-one-repo race this deterministic port exists to close).
      try {
        const handle = await startHubServer(repoRoot, { port: 0, onIdleShutdown });
        return { kind: 'started', handle };
      } catch (fallbackErr) {
        const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        return {
          kind: 'error',
          message: `derived port in use by a process that isn't this repo's hub — falling back to an ephemeral port also failed: ${message}`,
        };
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message };
  }
}

async function runHubStartMain(repoRoot: string, args: string[]): Promise<void> {
  const portArg = readOption(args, '--port');
  let port: number | undefined;
  if (portArg !== undefined) {
    port = Number(portArg);
    if (!Number.isFinite(port) || port < 0) {
      process.stderr.write(`hub start: invalid --port '${portArg}'\n`);
      process.exitCode = 2;
      return;
    }
  }

  const outcome = await startHubForCli(repoRoot, {
    port,
    onIdleShutdown: () => {
      process.stderr.write('hub: idle timeout reached, shutting down\n');
      process.exit(0);
    },
  });

  if (outcome.kind === 'already-running') {
    process.stdout.write(`hub already running (pid ${outcome.hub.pid}, port ${outcome.hub.port})\n`);
    process.exitCode = 0;
    return;
  }
  if (outcome.kind === 'error') {
    process.stderr.write(`hub start: ${outcome.message}\n`);
    process.exitCode = 1;
    return;
  }

  const { handle } = outcome;
  process.stdout.write(`hub started (pid ${handle.pid}, port ${handle.port})\n`);

  const shutdownAndExit = (signal: string): void => {
    void (async () => {
      process.stderr.write(`hub: received ${signal}, shutting down\n`);
      await handle.shutdown();
      process.exit(0);
    })();
  };
  process.once('SIGINT', () => shutdownAndExit('SIGINT'));
  process.once('SIGTERM', () => shutdownAndExit('SIGTERM'));
}

// ---------------------------------------------------------------------------
// ensure
// ---------------------------------------------------------------------------

export type HubEnsureStatus = 'already-running' | 'started' | 'timed-out';

export interface HubEnsureResult {
  status: HubEnsureStatus;
  hub: HubDescriptor | null;
}

export interface HubEnsureOptions {
  /** Injectable for tests — default spawns a real detached child process. */
  spawnStart?: (repoRoot: string, port: number) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/** Real, production spawn: a detached `hub start --port <n>` via this package's own bin entrypoint. */
function defaultSpawnStart(repoRoot: string, port: number): void {
  const thisFile = fileURLToPath(import.meta.url);
  const packageDir = path.dirname(path.dirname(thisFile)); // scripts/hub.ts -> scripts/ -> package root
  const binPath = path.join(packageDir, 'bin', 'tenbo-dashboard.mjs');

  const cacheDir = path.join(repoRoot, '.tenbo', 'cache');
  mkdirSync(cacheDir, { recursive: true });
  const logFd = openSync(path.join(cacheDir, 'hub.log'), 'a');

  // Spawn the package's own bin entrypoint (not the tsx loader directly):
  // bin/tenbo-dashboard.mjs already knows how to locate the tsx loader for
  // whatever install layout this package is running from.
  const child = spawn(process.execPath, [binPath, 'hub', 'start', '--port', String(port)], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
}

/**
 * Idempotent hub bootstrap: no-op if discovery finds a live hub, else spawns
 * one (detached) and polls discovery (bounded) until it's up. The spawned
 * child is handed a DETERMINISTIC per-repo port (derivePortForRepo) rather
 * than a true ephemeral one specifically so that two `ensure` calls racing
 * for the SAME repo collide on a real `EADDRINUSE` instead of silently
 * starting two independent hubs — the loser's spawned `hub start` process
 * exits cleanly (see startHubForCli's 'already-running' branch) and this
 * function's poll loop converges on whichever one actually bound the port.
 */
export async function runHubEnsure(repoRoot: string, options: HubEnsureOptions = {}): Promise<HubEnsureResult> {
  const existing = await discoverHub(repoRoot);
  if (existing) return { status: 'already-running', hub: existing };

  const port = derivePortForRepo(repoRoot);
  const spawnStart = options.spawnStart ?? defaultSpawnStart;
  try {
    spawnStart(repoRoot, port);
  } catch {
    // Fail open: if spawning itself throws (e.g. permissions), just fall
    // through to the poll loop, which will time out and report cleanly.
  }

  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const timeoutMs = options.timeoutMs ?? ensureTimeoutFromEnv();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hub = await discoverHub(repoRoot);
    if (hub) return { status: 'started', hub };
    await sleep(pollIntervalMs);
  }
  return { status: 'timed-out', hub: null };
}

// ---------------------------------------------------------------------------
// stop / status / dispatch
// ---------------------------------------------------------------------------

async function runHubStop(repoRoot: string): Promise<{ stopped: boolean; pid?: number; reason?: string }> {
  const descriptor = readHubLockfile(repoRoot);
  if (!descriptor) return { stopped: false, reason: 'not-running' };

  if (!isProcessAlive(descriptor.pid)) {
    removeHubLockfile(repoRoot);
    return { stopped: false, reason: 'stale' };
  }

  try {
    process.kill(descriptor.pid, 'SIGTERM');
  } catch {
    // Process died between the liveness check and here — fine, fall through to cleanup.
  }

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && readHubLockfile(repoRoot)) {
    await sleep(50);
  }
  // Fallback: target didn't clean up after itself. Ownership guard (td-037
  // review fix 1): only remove the lockfile if it still points at the pid we
  // asked to stop — if a newer hub has since taken over this repo's
  // lockfile (e.g. a racing `hub start` won while our target was dying),
  // don't delete out from under it.
  const remaining = readHubLockfile(repoRoot);
  if (remaining && remaining.pid === descriptor.pid) removeHubLockfile(repoRoot);

  return { stopped: true, pid: descriptor.pid };
}

export async function runHubCli(repoRoot: string, args: string[]): Promise<CliResult> {
  const json = hasFlag(args, '--json');
  const command = args.find((arg) => !arg.startsWith('--'));

  if (!command || command === 'help' || command === '--help') return ok(HELP_TEXT);

  try {
    if (command === 'ensure') {
      const result = await runHubEnsure(repoRoot);
      if (result.status === 'timed-out') {
        return fail('timeout', 'hub ensure: timed out waiting for the hub to come up', json, true);
      }
      const hub = result.hub as HubDescriptor;
      const verb = result.status === 'already-running' ? 'already running' : 'started';
      return serialize(
        { ok: true, status: result.status, pid: hub.pid, port: hub.port },
        json,
        `hub ${verb} (pid ${hub.pid}, port ${hub.port})\n`,
      );
    }

    if (command === 'status') {
      const hub = await discoverHub(repoRoot);
      if (!hub) return serialize({ ok: true, running: false }, json, 'hub: not running\n');
      const uptimeMs = Date.now() - Date.parse(hub.startedAt);
      return serialize(
        { ok: true, running: true, pid: hub.pid, port: hub.port, uptimeMs },
        json,
        `hub: running (pid ${hub.pid}, port ${hub.port}, uptime ${formatUptime(uptimeMs)})\n`,
      );
    }

    if (command === 'stop') {
      const result = await runHubStop(repoRoot);
      if (!result.stopped) {
        const text = result.reason === 'stale' ? 'hub: stale lockfile removed (process was not running)\n' : 'hub: not running\n';
        return serialize({ ok: true, stopped: false, reason: result.reason }, json, text);
      }
      return serialize({ ok: true, stopped: true, pid: result.pid }, json, `hub: stopped (pid ${result.pid})\n`);
    }

    if (command === 'start') {
      return misuse("hub start runs in the foreground and isn't a scriptable one-shot command; run it directly (not through runHubCli)", json);
    }

    return misuse(`hub: unknown subcommand '${command}'. Expected 'start', 'ensure', 'stop', or 'status'.`, json);
  } catch (err) {
    return handleCliError(err, json);
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === 'start') {
    void runHubStartMain(repoRootFromCwd(), args.slice(1));
  } else {
    runMain(await runHubCli(repoRootFromCwd(), args));
  }
}
