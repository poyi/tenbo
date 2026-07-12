/**
 * autostart.ts — lazy hub autostart on first write (td-038, Phase 3 of
 * x-006; see docs/superpowers/specs/2026-07-12-hub-autostart-design.md
 * section 2 "lazy autostart" and section 4 "safety & failure modes").
 *
 * `performMutation` (scripts/item.ts) calls `maybeAutostartHub` at the
 * discovery-miss point — the moment `discoverHub` finds no live hub for this
 * repo. This module's whole job is to spawn one WITHOUT ever slowing down or
 * breaking the mutation that triggered it:
 *
 *   - It spawns `hub ensure` (scripts/hub.ts), NOT bare `hub start`. `ensure`
 *     is the race-safe idempotent entrypoint from td-037: discover-first, a
 *     deterministic per-repo port so concurrent callers converge on ONE hub,
 *     and an ephemeral-port fallback if that port is squatted by an
 *     unrelated process. Spawning `start` directly here would let two agents
 *     autostarting at once each bind their own hub.
 *   - It is fire-and-forget: the child is spawned `detached` + `unref()`'d
 *     and this function returns synchronously without awaiting the child's
 *     health, mirroring the detached-spawn hygiene of `hub.ts`'s
 *     `defaultSpawnStart` (stdio redirected to `.tenbo/cache/hub.log`, not
 *     inherited). Zero added latency on the triggering mutation.
 *   - It is absolutely fail-open: any error (spawn throws, fs error, path
 *     resolution failure) is swallowed here. Autostart is a pure enhancement
 *     layered on top of the existing direct-write fallback; it can never
 *     block or break a write.
 *   - `TENBO_NO_AUTOSTART` (any non-empty value) disables it entirely.
 *   - A one-time stderr note fires the first time autostart actually spawns
 *     a hub in this process (module-level `hasNotified`), never on stdout
 *     and never as part of `--json` output.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUTOSTART_NOTE = 'note: started a local tenbo coordination server; disable with TENBO_NO_AUTOSTART=1\n';

let hasNotified = false;

/** Test-only: clear the one-time-note flag between test cases. */
export function resetAutostartNotifiedForTests(): void {
  hasNotified = false;
}

export interface MaybeAutostartHubOptions {
  /** Injectable for tests — default spawns a real detached child process. */
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Injectable for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. Defaults to writing to `process.stderr`. */
  notify?: (message: string) => void;
}

function resolveBinPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // src/api/lib/hub/autostart.ts -> hub/ -> lib/ -> api/ -> src/ -> package root
  const packageDir = path.resolve(path.dirname(thisFile), '..', '..', '..', '..');
  return path.join(packageDir, 'bin', 'tenbo-dashboard.mjs');
}

/**
 * Fire-and-forget: if no hub was found for `repoRoot` and autostart isn't
 * opted out, spawn `hub ensure` detached and return immediately. Never
 * throws, never awaits the spawned process coming up.
 */
export function maybeAutostartHub(repoRoot: string, options: MaybeAutostartHubOptions = {}): void {
  const env = options.env ?? process.env;
  if (env.TENBO_NO_AUTOSTART) return;

  try {
    const spawnImpl = options.spawnImpl ?? spawn;
    const notify = options.notify ?? ((message: string) => { process.stderr.write(message); });

    const binPath = resolveBinPath();
    const cacheDir = path.join(repoRoot, '.tenbo', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const logFd = openSync(path.join(cacheDir, 'hub.log'), 'a');

    const child = spawnImpl(process.execPath, [binPath, 'hub', 'ensure'], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();

    if (!hasNotified) {
      hasNotified = true;
      notify(AUTOSTART_NOTE);
    }
  } catch {
    // Fail open (td-038): autostart can never block or break the write that
    // triggered it — see module doc above.
  }
}
