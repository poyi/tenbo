/**
 * doneWhenChecks.ts — parse, validate, and (only on explicit request) EXECUTE
 * the structured `check` a `done_when` entry may carry (x-003).
 *
 * SECURITY / TRUST MODEL — read before touching this file:
 *   - `runDoneWhenChecks` / `evaluateDoneWhenEntry` / `runCheckCommand` are the
 *     ONLY functions in this codebase that execute an item-authored shell
 *     command. They must be called ONLY from `scripts/item.ts`'s
 *     `verify --check` handler (an explicit, human/agent-invoked CLI command).
 *   - NEVER call these from a read path (session start, `context`, `sync`,
 *     `validate`, metrics, or anything that runs automatically/in the
 *     background). Validation of the `check` SHAPE (is `run` a non-empty
 *     string, is `timeout_ms` within the cap, etc.) happens in `validator.ts`
 *     and never executes anything — shape-checking is safe to run anywhere.
 *   - Every execution has a hard, enforced timeout. On timeout the process
 *     GROUP is killed (SIGTERM, then SIGKILL after a short grace period). The
 *     ACTUAL guarantee: the check is ALWAYS resolved as a failed/timed-out
 *     result within the timeout budget (plus the fixed kill/settle grace) —
 *     the CLI never hangs and never falsely passes. Resolution does NOT wait
 *     on the child's `'close'` event (pipe EOF), because a command that
 *     backgrounds or double-forks+`setsid()`s a descendant can leave that
 *     descendant holding the inherited stdout/stderr pipe open indefinitely,
 *     which would otherwise stall `'close'` forever. What we do NOT
 *     guarantee: that every descendant process is actually dead. A
 *     deliberately-detached grandchild that `setsid()`s into its own
 *     session escapes `process.kill(-pid, …)` (an OS process-group
 *     limitation, not fixable here without cgroups/containers) and MAY
 *     survive as an orphan after we've already reported the check as
 *     failed. That's a resource-cleanup gap, not a correctness gap: the CLI
 *     result is still accurate and still bounded.
 *   - Commands run with the repo root as cwd. No network calls are added
 *     here — whatever the command itself does is the item author's
 *     responsibility; this module only enforces the timeout/kill discipline
 *     and captures/truncates output.
 *   - Captured stdout/stderr are truncated to `OUTPUT_TRUNCATE_BYTES` before
 *     being recorded as evidence, so a runaway command can't bloat the
 *     roadmap YAML.
 */
import { spawn } from 'node:child_process';
import type { DoneWhenCheck, DoneWhenEntry } from '../../types';
import { doneWhenText, isStructuredDoneWhen } from './doneWhenShape';

export { doneWhenText, isStructuredDoneWhen } from './doneWhenShape';

/** Applied when a `check` omits `expect_exit`. */
export const DEFAULT_EXPECT_EXIT = 0;
/** Applied when a `check` omits `timeout_ms`. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Hard ceiling — no `check`, however configured, may run longer than this. */
export const MAX_TIMEOUT_MS = 300_000;
/** Grace period between SIGTERM and SIGKILL when a check overruns its timeout. */
export const KILL_GRACE_MS = 2_000;
/**
 * After SIGKILL, how long to wait for a normal `'close'` before resolving
 * anyway. Covers the case where a backgrounded/detached descendant still
 * holds the inherited stdout/stderr pipe open — see the module comment.
 */
export const SETTLE_GRACE_MS = 500;
/** Captured stdout/stderr are truncated to this many bytes before being recorded as evidence. */
export const OUTPUT_TRUNCATE_BYTES = 2_048;
/** Hard cap on `check.run` length (chars), enforced in validator.ts. Defense in depth — a check command is meant to be a short shell invocation, not an embedded script. */
export const MAX_CHECK_RUN_LENGTH = 4_096;

export type DoneWhenCheckStatus = 'pass' | 'fail' | 'manual';

export interface DoneWhenCheckResult {
  /** The human-readable criterion (the plain string itself, or the structured entry's `text`). */
  text: string;
  /** Whether this entry carried an executable `check` or is prose only. */
  kind: 'check' | 'manual';
  status: DoneWhenCheckStatus;
  /** Present only for kind:'check'. */
  run?: string;
  exit_code?: number | null;
  expect_exit?: number;
  timed_out?: boolean;
  stdout?: string;
  stderr?: string;
  duration_ms?: number;
  /** Set when the command itself couldn't be spawned (e.g. shell missing). */
  error?: string;
}

function truncate(text: string): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= OUTPUT_TRUNCATE_BYTES) return text;
  return `${buf.subarray(0, OUTPUT_TRUNCATE_BYTES).toString('utf8')}\n...[truncated]`;
}

/** Clamp a requested timeout to the hard cap, applying the default when unset. Defense in depth — validator.ts should already have rejected an over-cap value, but execution never trusts that alone. */
export function resolveTimeoutMs(check: DoneWhenCheck): number {
  const requested = check.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(requested, 1), MAX_TIMEOUT_MS);
}

interface RawRunResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

/**
 * Execute one shell command with a strict, enforced timeout. Runs via
 * `/bin/sh -c <run>` in a NEW process group (`detached: true`) so that, on
 * timeout, `process.kill(-pid, signal)` reaches every descendant the command
 * spawned, not just the shell itself. Escalates SIGTERM → SIGKILL exactly
 * like the existing shell-hook watcher pattern in `scripts/hook.ts`.
 *
 * Resolution is driven by TWO independent paths, whichever settles first:
 *   1. The normal path — the child's `'close'`/`'error'` event, used for the
 *      common case where the command (and everything it spawned) has fully
 *      exited and closed its inherited stdio.
 *   2. The timeout path — once the timeout fires, we send SIGTERM → (grace)
 *      → SIGKILL to the process group, then start a short bounded "settle"
 *      timer. When THAT elapses we resolve as a timed-out failure
 *      REGARDLESS of whether `'close'` ever fired. This is what makes
 *      resolution independent of pipe EOF: a backgrounded or
 *      double-forked+`setsid()`d descendant can hold the inherited
 *      stdout/stderr pipe open (or even escape the group kill entirely),
 *      which would otherwise stall `'close'` forever. `finish()` is
 *      idempotent (a `settled` guard), so whichever path gets there first
 *      wins and a later, e.g. real, `'close'` is a no-op.
 *
 * ONLY called from `evaluateDoneWhenEntry`, which is ONLY called from
 * `scripts/item.ts`'s `verify --check` handler. Do not call this from any
 * automatic/background path.
 */
export function runCheckCommand(repoRoot: string, check: DoneWhenCheck): Promise<RawRunResult> {
  const timeoutMs = resolveTimeoutMs(check);
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    let child;
    try {
      child = spawn('/bin/sh', ['-c', check.run], {
        cwd: repoRoot,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Group already gone — either the process exited between the timeout
        // firing and the kill call, or (for a setsid()'d descendant) it was
        // never a member of this group to begin with. Either way, the
        // settle timer below still resolves the check.
      }
    };

    const termTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killGroup('SIGKILL');
        // Give a normal `'close'` a brief window to arrive on its own, then
        // resolve unconditionally — do not wait on pipe EOF that may never
        // come from an escaped/backgrounded descendant.
        settleTimer = setTimeout(() => {
          finish({ exitCode: null, stdout: truncate(stdout), stderr: truncate(stderr) });
        }, SETTLE_GRACE_MS);
      }, KILL_GRACE_MS);
    }, timeoutMs);

    const finish = (result: Omit<RawRunResult, 'durationMs' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      // Unblock the event loop: once we've decided on a result, stop
      // listening and let Node exit even if a detached descendant is still
      // holding the pipe (or the process itself) open. Destroying the
      // streams drops their read refs; unref()'ing the child drops its
      // exit-watcher ref.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.removeAllListeners();
      child.unref();
      resolve({ ...result, timedOut, durationMs: Date.now() - start });
    };

    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      finish({ exitCode: null, stdout: truncate(stdout), stderr: truncate(stderr), error: err.message });
    });

    child.on('close', (code) => {
      finish({ exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr) });
    });
  });
}

/** Evaluate one `done_when` entry: run its check if it has one, else report `manual`. Never executes for plain-string or check-less entries. */
export async function evaluateDoneWhenEntry(repoRoot: string, entry: DoneWhenEntry): Promise<DoneWhenCheckResult> {
  if (!isStructuredDoneWhen(entry)) {
    return { text: doneWhenText(entry), kind: 'manual', status: 'manual' };
  }
  const expectExit = entry.check.expect_exit ?? DEFAULT_EXPECT_EXIT;
  const run = await runCheckCommand(repoRoot, entry.check);
  const pass = !run.timedOut && !run.error && run.exitCode === expectExit;
  return {
    text: entry.text,
    kind: 'check',
    run: entry.check.run,
    status: pass ? 'pass' : 'fail',
    exit_code: run.exitCode,
    expect_exit: expectExit,
    timed_out: run.timedOut,
    stdout: run.stdout,
    stderr: run.stderr,
    duration_ms: run.durationMs,
    ...(run.error ? { error: run.error } : {}),
  };
}

/** Evaluate a full `done_when` list, sequentially (predictable resource use; check counts are small). */
export async function runDoneWhenChecks(repoRoot: string, entries: DoneWhenEntry[]): Promise<DoneWhenCheckResult[]> {
  const results: DoneWhenCheckResult[] = [];
  for (const entry of entries) {
    results.push(await evaluateDoneWhenEntry(repoRoot, entry));
  }
  return results;
}

export interface DoneWhenCheckSummary {
  /** `true` iff every structured check passed. Manual entries never block this. Vacuously `true` when there are no structured checks. */
  passed: boolean;
  checkedCount: number;
  manualCount: number;
  failedCount: number;
}

export function summarizeDoneWhenResults(results: DoneWhenCheckResult[]): DoneWhenCheckSummary {
  const checks = results.filter((r) => r.kind === 'check');
  const failed = checks.filter((r) => r.status !== 'pass');
  return {
    passed: failed.length === 0,
    checkedCount: checks.length,
    manualCount: results.length - checks.length,
    failedCount: failed.length,
  };
}

/** One compact evidence line per executed check, suitable for `ItemVerification.evidence`. */
export function formatCheckEvidence(result: DoneWhenCheckResult): string {
  if (result.kind !== 'check') return `manual: ${result.text}`;
  const outcome = result.timed_out ? 'timeout (killed)' : result.status === 'pass' ? 'pass' : 'fail';
  return `check: ${result.run} -> exit=${result.exit_code ?? 'null'} expected=${result.expect_exit} (${outcome})`;
}
