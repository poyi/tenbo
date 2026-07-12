# Automatic Hub Setup — Design

**Status:** Approved design (2026-07-12). Builds on the 0.12.0 multi-agent hub (x-004).

## TL;DR

Make the tenbo "hub" (the single-writer coordination server) start itself, so concurrent
agents get write-coordination with zero manual setup. Three composing pieces: (1) a
**headless hub mode** — a minimal API-only server that boots in milliseconds; (2) **lazy
autostart** — the first mutating CLI call with no hub spawns one, detached and fail-open;
(3) a **batch `hub ensure`** step so parallel dispatch never cold-start-races. An idle
timer self-reaps the hub, so nobody needs to own its lifecycle. Everything degrades to
today's direct-write behavior if anything fails.

## Problem

The 0.12.0 hub coordinates concurrent agents into a single serialized writer, but only if
a hub is *running* — today that means a human starts `npx tenbo-dashboard` (the full web
dashboard). Absent that, concurrent agents fall back to independent direct writes, which is
exactly the fragmentation the hub exists to prevent. The coordination benefit is real but
gated behind a manual step most users won't take.

Two things block auto-setup today:
1. The only hub is the full Vite dashboard — too heavy to silently spawn (seconds to boot,
   browser-oriented).
2. Nothing starts a hub automatically at the moments coordination is needed.

The discovery/lockfile plumbing already exists (repo-scoped lockfile, cross-worktree
resolution via `git --git-common-dir`, dead-pid/stale-lockfile cleanup, fail-open fallback
in `performMutation`). Only the "who starts it, and when" is missing.

## Design

### 1. Headless hub mode

New CLI `tenbo-dashboard hub` with `start` / `ensure` / `stop` / `status`.

- `start` runs a minimal `node:http` server serving ONLY `/api/hub/health` and
  `/api/hub/mutate` (reusing the existing route handlers) — no Vite, no browser UI — so it
  boots in tens of ms. It writes the same `.tenbo/cache/hub.json` lockfile the full
  dashboard writes and removes it on exit, so discovery treats headless and full-UI hubs
  identically.
- The full `npx tenbo-dashboard` already serves those endpoints and writes the lockfile
  (0.12.0), so it simply *is* a hub too. Headless is the UI-less variant; both satisfy
  discovery.
- `ensure` is idempotent: run discovery; if a live hub exists, no-op; else spawn `start`
  detached and wait until `/api/hub/health` responds (bounded).
- `stop` reads the lockfile and terminates the hub (repo-scoped; only this repo's hub).
- `status` reports whether a hub is running and its pid/port/uptime.

### 2. Two triggers

- **Lazy autostart (any agent, any terminal):** in `performMutation` (scripts/item.ts),
  when discovery finds no hub AND `TENBO_NO_AUTOSTART` is unset, spawn `hub start` detached +
  unref'd, print a one-time stderr note
  (`note: started a local tenbo coordination server; disable with TENBO_NO_AUTOSTART=1`),
  and do a direct write for THIS mutation (fail-open, exactly as today). The hub is then live
  for every subsequent write and for other agents. No blocking wait → zero added latency on
  the triggering call. The very first write on a fresh no-hub repo has nothing to coordinate
  with yet; by the time a second concurrent writer appears, the hub is up.
- **Batch Execute (orchestrator, skill):** `references/batch-execute.md` adds a step: run
  `tenbo-dashboard hub ensure` BEFORE fanning out parallel workers, so workers never
  cold-start-race. Teardown is handled by idle-shutdown, so no explicit stop is needed — the
  two features compose. (`hub stop` remains available for manual use.)

### 3. Lifecycle

- **Idle shutdown:** the hub tracks last-activity; any `/api/hub/*` request resets a timer.
  After `TENBO_HUB_IDLE_MS` (default 900000 = 15 min) with no activity, it removes its
  lockfile and exits. This is what makes the lazy, nobody-owns-it case safe.
- **Single hub per repo:** always run discovery before spawning; a live hub (headless or
  full) satisfies it. Concurrent cold-start races resolve on port bind — the loser gets
  `EADDRINUSE`, exits cleanly, and re-discovers the winner's lockfile. Reuses the existing
  dead-pid/stale-lockfile cleanup for crashed owners.

### 4. Safety & failure modes

- **Opt-out:** `TENBO_NO_AUTOSTART=1` disables lazy autostart (falls back to direct writes).
  `TENBO_HUB_IDLE_MS` tunes the reaper. Explicit `hub start`/`ensure` still work — those are
  deliberate actions, not "auto."
- **Localhost only, no auth** — same posture as 0.12.0; remote/token access stays deferred
  (td-031). The auto-spawned process is localhost-bound and idle-reaped.
- **Fail-open everywhere:** if the spawn fails for any reason (can't spawn, port exhaustion,
  fs error), the mutation just does a direct write. The feature can never block or break a
  write; worst case is today's behavior.

## Components (each testable in isolation)

- **`src/api/lib/hub/hubServer.ts`** — the headless server: health + mutate handlers (reuse
  existing route logic), lockfile write/remove, idle timer + activity tracking,
  `EADDRINUSE`-graceful startup.
- **`scripts/hub.ts`** — thin CLI dispatcher (`start` / `ensure` / `stop` / `status`).
- **`src/api/lib/hub/autostart.ts`** — detached-spawn helper, the `TENBO_NO_AUTOSTART` check,
  and the one-time note; called from `performMutation`.
- **skill change** — `references/batch-execute.md` gains the `hub ensure` pre-dispatch step.

## Integration points

- Reuses `discover.ts`, `lockfile.ts`, `hubRepoRoot.ts`, `mutationQueue.ts`, `mutations.ts`,
  and the `hubHealth`/`hubMutate` route handlers from 0.12.0 — no changes to the write path
  or the claim/idempotency mechanism.
- The full dashboard (`plugin.ts`) already writes the lockfile and serves the hub routes; no
  change needed there beyond confirming parity with the headless server's lockfile shape.

## Non-goals

- No remote/networked hub or auth (that's td-031, deferred).
- No change to the mutation serialization, journal, attribution, or idempotency logic.
- No persistent daemon or OS service — the hub is ephemeral and idle-reaped.
- No auto-install of anything into the user's shell/git config.

## Risks

- **Auto-spawned background process is more "magic."** Mitigation: localhost-only, ephemeral,
  idle-reaped, one-time discoverable note, `TENBO_NO_AUTOSTART` opt-out.
- **Cold-start race on a fresh repo** (two agents both direct-write before the hub is up).
  Mitigation: this equals today's no-hub behavior (no regression); the window closes once the
  hub binds. `hub ensure` in Batch Execute removes it entirely for the parallel case.
- **Idle timeout tuning.** 15 min default survives typical think-time gaps without lingering
  long; tunable via `TENBO_HUB_IDLE_MS`.
- **Detached process hygiene** (zombies, stdio). Mitigation: `detached: true` + `unref()`,
  stdio redirected to a log/devnull, lockfile removed on clean exit, stale-lockfile cleanup
  for unclean exits.

## Roadmap breakdown

Cross-cutting parent with children:
- **Headless hub server + `hub` CLI** (`start`/`ensure`/`stop`/`status`) — dashboard.
- **Idle-shutdown + activity tracking + single-hub coexistence** — dashboard (may fold into
  the server item).
- **Lazy autostart-on-first-write** with `TENBO_NO_AUTOSTART` opt-out + one-time note —
  dashboard.
- **Batch Execute `hub ensure` pre-dispatch step** — skill.
