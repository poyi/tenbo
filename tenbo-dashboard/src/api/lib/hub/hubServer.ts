/**
 * hubServer.ts — the headless hub: a minimal `node:http` server that serves
 * ONLY `/api/hub/health` and `/api/hub/mutate` (td-037, Phase 1 of x-006).
 *
 * This is the UI-less sibling of the full Vite dashboard's hub mode
 * (`src/api/plugin.ts`): both mount the SAME route handlers
 * (`hubHealthRoute` / `hubMutateRoute`) and write the SAME lockfile shape
 * via `writeHubLockfile`/`removeHubLockfile`, so `discoverHub` cannot tell
 * a headless hub from a full-dashboard hub apart — that parity is load
 * bearing, not incidental (see hubServer.test.ts's "lockfile parity" case).
 *
 * Three responsibilities beyond wiring the two routes:
 *
 *   1. Bind an ephemeral port by default (`listen(0)`, mirroring how
 *      plugin.ts reads back `server.address().port` after the underlying
 *      HTTP server actually binds) and write the lockfile only once bound.
 *      If a specific port is requested and already taken, `startHubServer`
 *      rejects with `HubPortInUseError` instead of throwing a raw Node
 *      error, so callers (scripts/hub.ts) can fail cleanly rather than
 *      crash — see that file's `startHubForCli` for the "loser exits
 *      cleanly" handling this enables.
 *   2. Track activity: any request under `/api/hub/` resets an
 *      injectable-clock last-activity timestamp.
 *   3. Idle shutdown: `checkIdle()` is a pure, directly-callable check (no
 *      hidden real timers to fight in tests) that closes the server and
 *      removes the lockfile once `idleMs` has elapsed with no activity. A
 *      production `startHubServer` call also arms a background interval
 *      that calls the same `checkIdle()`, but tests can disable that
 *      interval (`idleCheckIntervalMs: 0`) and drive `checkIdle()` directly
 *      against an injected `now()` — no `sleep()` needed to prove the 15
 *      minute default actually works.
 */

import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { hubHealthRoute } from '../../routes/hubHealth';
import { hubMutateRoute } from '../../routes/hubMutate';
import { writeHubLockfile, removeHubLockfile, readHubLockfile, canonicalRepoRoot } from './lockfile';
import { resolveHubRepoRoot } from './hubRepoRoot';

/** Default idle-shutdown budget (15 min) — see design doc section 3. */
const DEFAULT_IDLE_MS = 900_000;

/** Reads `TENBO_HUB_IDLE_MS`, falling back to the 15-minute default for any missing/invalid value. */
export function idleMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TENBO_HUB_IDLE_MS;
  if (!raw) return DEFAULT_IDLE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_MS;
}

/**
 * Deterministic per-repo port, derived from a hash of the canonical shared
 * hub repo root. This is NOT the default `hub start` uses (that stays
 * `listen(0)`, true OS-assigned ephemeral, per the design doc) — it exists
 * so `hub ensure`'s detached spawn (scripts/hub.ts) can hand the SAME
 * candidate port to two concurrently-racing `ensure` invocations for the
 * SAME repo, turning "which one becomes the hub" into a real, deterministic
 * `EADDRINUSE` race instead of two independent ephemeral binds that would
 * silently both succeed and fight over the lockfile.
 */
export function derivePortForRepo(repoRoot: string): number {
  const canonical = canonicalRepoRoot(resolveHubRepoRoot(repoRoot) ?? repoRoot);
  const hash = createHash('sha1').update(canonical).digest();
  const value = hash.readUInt32BE(0);
  return 20_000 + (value % 20_000); // [20000, 40000)
}

export class HubPortInUseError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`tenbo hub: port ${port} is already in use`);
    this.name = 'HubPortInUseError';
    this.port = port;
  }
}

export interface HubServerOptions {
  /** Port to bind. Defaults to 0 (OS-assigned ephemeral port). */
  port?: number;
  /** Idle-shutdown budget in ms. Defaults to `idleMsFromEnv()`. */
  idleMs?: number;
  /** Injectable clock — tests drive idle-shutdown deterministically through this. */
  now?: () => number;
  /**
   * Cadence of the production background idle-check interval. Set to 0 to
   * disable it entirely (tests do this and call `checkIdle()` directly, so
   * no real timer is ever armed). Defaults to `min(idleMs, 30_000)`.
   */
  idleCheckIntervalMs?: number;
  /** Called once idle-shutdown actually closes the server and removes the lockfile. */
  onIdleShutdown?: (info: { repoRoot: string }) => void;
}

export interface HubServerHandle {
  readonly server: Server;
  readonly port: number;
  readonly pid: number;
  readonly repoRoot: string;
  readonly startedAt: number;
  getLastActivityAt(): number;
  /** Pure, directly callable idle check — returns true iff this call triggered shutdown. */
  checkIdle(): Promise<boolean>;
  /** Idempotent: clears the idle timer, removes the lockfile, and closes the server. */
  shutdown(): Promise<void>;
}

/**
 * Start the headless hub server for `repoRoot`. Resolves once the server is
 * actually listening and the lockfile has been written (byte-compatible
 * with `plugin.ts`'s `writeHubLockfile` call, same helper). Rejects with
 * `HubPortInUseError` if an explicitly-requested port is already bound by
 * something else — never with a raw `EADDRINUSE` `Error`, and never leaves
 * a listening-but-unlockfiled server behind.
 */
export async function startHubServer(repoRoot: string, options: HubServerOptions = {}): Promise<HubServerHandle> {
  const now = options.now ?? (() => Date.now());
  const idleMs = options.idleMs ?? idleMsFromEnv();
  const requestedPort = options.port ?? 0;

  const health = hubHealthRoute(repoRoot);
  const mutate = hubMutateRoute(repoRoot);

  let lastActivityAt = now();
  const touch = (): void => {
    lastActivityAt = now();
  };

  const server = createServer((req, res) => {
    if (req.url && req.url.startsWith('/api/hub/')) touch();
    health(req, res, () => {
      mutate(req, res, () => {
        res.statusCode = 404;
        res.end();
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') reject(new HubPortInUseError(requestedPort));
      else reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, '127.0.0.1');
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  writeHubLockfile(repoRoot, port);

  let closed = false;
  let intervalHandle: NodeJS.Timeout | undefined;

  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (intervalHandle) clearInterval(intervalHandle);
    // Ownership guard (td-037 review fix 1): only remove the lockfile if it
    // still describes THIS handle. Two racing bare `hub start`s for one repo
    // each bind a distinct ephemeral port and both write the same lockfile
    // path; if the loser's idle timer/SIGTERM fires shutdown() after the
    // winner has since overwritten the descriptor, an unconditional removal
    // here would delete the WINNER's lockfile out from under it. If the
    // descriptor no longer matches (pid+port), someone else owns it now —
    // leave it alone.
    const cur = readHubLockfile(repoRoot);
    if (cur?.pid === process.pid && cur?.port === port) removeHubLockfile(repoRoot);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const checkIdle = async (): Promise<boolean> => {
    if (closed) return false;
    if (now() - lastActivityAt < idleMs) return false;
    await shutdown();
    options.onIdleShutdown?.({ repoRoot });
    return true;
  };

  const intervalMs = options.idleCheckIntervalMs ?? Math.min(idleMs, 30_000);
  if (intervalMs > 0) {
    intervalHandle = setInterval(() => {
      void checkIdle();
    }, intervalMs);
    intervalHandle.unref?.();
  }

  return {
    server,
    port,
    pid: process.pid,
    repoRoot,
    startedAt: now(),
    getLastActivityAt: () => lastActivityAt,
    checkIdle,
    shutdown,
  };
}
