/**
 * hook.ts — install / uninstall the opt-in tenbo pre-commit hook.
 *
 * Runs the deterministic validator (`tenbo-dashboard validate --strict`) at
 * commit time so duplicate-IDs, broken refs, and schema violations surface
 * BEFORE bad shapes enter history. Tier 1 only — no LLM, sub-500ms.
 *
 * Subcommands (from `tenbo-dashboard hook ...`):
 *   install [--dry-run] [--force]
 *   uninstall
 *   status   (introspect — useful for tests + users)
 *
 * Install strategy (in order of preference):
 *   1. If `.husky/pre-commit` exists → append a clearly-delimited tenbo block
 *      to the husky file. Less surprising for husky users than touching
 *      `.git/hooks/`.
 *   2. Else if `.git/hooks/pre-commit` is absent → create it standalone with
 *      the tenbo header.
 *   3. Else if existing `.git/hooks/pre-commit` already carries the tenbo
 *      header → no-op (already installed).
 *   4. Else (foreign hook present) → chained-hook pattern: move existing to
 *      `pre-commit.local`, write a new `pre-commit` that runs the local one
 *      first (preserving exit code) then the tenbo check.
 *
 * Uninstall is surgical and idempotent — only undoes what install added.
 *
 * Written in vanilla TS (no external deps) and exported as pure functions
 * for unit testing. The `if (isMain())` block runs the CLI side-effects.
 */
import fs from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from '../src/api/lib/repoRoot';

export const TENBO_HEADER_MARKER = '# tenbo-managed pre-commit hook (sk-032)';
export const TENBO_HUSKY_BEGIN = '### tenbo-managed (sk-032) BEGIN ###';
export const TENBO_HUSKY_END = '### tenbo-managed (sk-032) END ###';

/** The body of the pre-commit script the hook runs (POSIX sh, no bash-isms). */
export const HOOK_BODY = `#!/usr/bin/env sh
${TENBO_HEADER_MARKER}
# Runs the deterministic validator on .tenbo/ before allowing commit.
# Errors block commit; warnings print but don't block.
# Bypass with \`git commit --no-verify\`.

# Skip if no .tenbo/ in repo (graceful no-op for non-tenbo repos)
if [ ! -d .tenbo ]; then exit 0; fi

# Run validate with strict mode
npx --no-install tenbo-dashboard validate --strict
`;

/** Husky-style block, appended to an existing .husky/pre-commit file. */
export const HUSKY_BLOCK = `\n${TENBO_HUSKY_BEGIN}
if [ -d .tenbo ]; then
  npx --no-install tenbo-dashboard validate --strict || exit $?
fi
${TENBO_HUSKY_END}\n`;

/** Chained-hook pre-commit body when a foreign hook was present. */
export function chainedHookBody(localHookRelPath: string): string {
  return `#!/usr/bin/env sh
${TENBO_HEADER_MARKER}
# Chained install — runs the previously-installed hook first, then tenbo's
# validator. Uninstalling restores the local hook to its original location.

LOCAL_HOOK="$(dirname "$0")/${path.basename(localHookRelPath)}"
if [ -x "$LOCAL_HOOK" ]; then
  "$LOCAL_HOOK" "$@" || exit $?
fi

if [ -d .tenbo ]; then
  npx --no-install tenbo-dashboard validate --strict
fi
`;
}

export type InstallMode = 'standalone' | 'chained' | 'husky' | 'already-installed';

export interface InstallPlan {
  mode: InstallMode;
  /** Absolute paths the install would write/move. */
  writes: { path: string; reason: string; chmod?: boolean }[];
  moves: { from: string; to: string }[];
  notes: string[];
}

export interface InstallContext {
  repoRoot: string;
  /** Whether to overwrite a foreign hook in place (skips chaining). */
  force?: boolean;
}

function isTenboManaged(content: string): boolean {
  return content.includes(TENBO_HEADER_MARKER) || content.includes(TENBO_HUSKY_BEGIN);
}

/** Compute the install plan WITHOUT touching the filesystem. */
export function planInstall(ctx: InstallContext): InstallPlan {
  const huskyPath = path.join(ctx.repoRoot, '.husky', 'pre-commit');
  const hookPath = path.join(ctx.repoRoot, '.git', 'hooks', 'pre-commit');

  // Husky integration: prefer if .husky/pre-commit exists.
  if (fs.existsSync(huskyPath)) {
    const content = fs.readFileSync(huskyPath, 'utf8');
    if (isTenboManaged(content)) {
      return {
        mode: 'already-installed',
        writes: [],
        moves: [],
        notes: [`tenbo block already present in ${huskyPath}`],
      };
    }
    return {
      mode: 'husky',
      writes: [{ path: huskyPath, reason: 'append tenbo block to existing husky pre-commit', chmod: true }],
      moves: [],
      notes: [
        `Detected husky at ${huskyPath} — appending tenbo block (delimited by ${TENBO_HUSKY_BEGIN} / ${TENBO_HUSKY_END}).`,
      ],
    };
  }

  // No husky. Look at .git/hooks/pre-commit.
  if (!fs.existsSync(hookPath)) {
    return {
      mode: 'standalone',
      writes: [{ path: hookPath, reason: 'create new pre-commit hook (no existing hook found)', chmod: true }],
      moves: [],
      notes: ['No existing pre-commit hook found — installing standalone.'],
    };
  }

  const existing = fs.readFileSync(hookPath, 'utf8');
  if (isTenboManaged(existing)) {
    return {
      mode: 'already-installed',
      writes: [],
      moves: [],
      notes: [`Tenbo header already present in ${hookPath}`],
    };
  }

  if (ctx.force) {
    return {
      mode: 'standalone',
      writes: [{ path: hookPath, reason: 'overwrite foreign hook (--force)', chmod: true }],
      moves: [],
      notes: [`--force: overwriting existing non-tenbo hook at ${hookPath}.`],
    };
  }

  // Chained install — preserve existing hook by moving it aside.
  const localPath = hookPath + '.local';
  return {
    mode: 'chained',
    writes: [{ path: hookPath, reason: 'write chained hook that runs local then tenbo', chmod: true }],
    moves: [{ from: hookPath, to: localPath }],
    notes: [
      `Existing non-tenbo hook detected at ${hookPath}.`,
      `It will be preserved at ${localPath} and chained: local hook runs first, then tenbo validator.`,
    ],
  };
}

/** Apply an install plan. Returns the same plan for caller reporting. */
export function applyInstall(plan: InstallPlan): InstallPlan {
  // Moves first (so chained mode can free the original path before write).
  for (const m of plan.moves) {
    fs.renameSync(m.from, m.to);
  }
  for (const w of plan.writes) {
    fs.mkdirSync(path.dirname(w.path), { recursive: true });
    let body: string;
    if (plan.mode === 'husky') {
      const existing = fs.existsSync(w.path) ? fs.readFileSync(w.path, 'utf8') : '';
      body = existing.endsWith('\n') ? existing + HUSKY_BLOCK : existing + '\n' + HUSKY_BLOCK;
    } else if (plan.mode === 'chained') {
      const moved = plan.moves.find((m) => m.to.endsWith('.local'));
      body = chainedHookBody(moved ? moved.to : 'pre-commit.local');
    } else {
      body = HOOK_BODY;
    }
    fs.writeFileSync(w.path, body);
    if (w.chmod) fs.chmodSync(w.path, 0o755);
  }
  return plan;
}

export type UninstallMode = 'standalone' | 'chained' | 'husky' | 'not-installed';

export interface UninstallPlan {
  mode: UninstallMode;
  removes: string[];
  /** Move (restore) operations: e.g. `pre-commit.local` → `pre-commit`. */
  restores: { from: string; to: string }[];
  /** In-place edits (husky block removal). */
  edits: { path: string; before: string; after: string }[];
  notes: string[];
}

export function planUninstall(repoRoot: string): UninstallPlan {
  const huskyPath = path.join(repoRoot, '.husky', 'pre-commit');
  const hookPath = path.join(repoRoot, '.git', 'hooks', 'pre-commit');
  const localPath = hookPath + '.local';

  // Husky path takes priority if the husky file carries the tenbo block.
  if (fs.existsSync(huskyPath)) {
    const content = fs.readFileSync(huskyPath, 'utf8');
    if (content.includes(TENBO_HUSKY_BEGIN)) {
      const after = stripHuskyBlock(content);
      return {
        mode: 'husky',
        removes: [],
        restores: [],
        edits: [{ path: huskyPath, before: content, after }],
        notes: [`Removing tenbo block from ${huskyPath}.`],
      };
    }
  }

  if (!fs.existsSync(hookPath)) {
    return { mode: 'not-installed', removes: [], restores: [], edits: [], notes: ['No tenbo-managed hook found.'] };
  }

  const content = fs.readFileSync(hookPath, 'utf8');
  if (!content.includes(TENBO_HEADER_MARKER)) {
    return {
      mode: 'not-installed',
      removes: [],
      restores: [],
      edits: [],
      notes: [`Hook at ${hookPath} is not tenbo-managed — leaving it alone.`],
    };
  }

  // Tenbo-managed. Chained if a sibling .local exists.
  if (fs.existsSync(localPath)) {
    return {
      mode: 'chained',
      removes: [],
      restores: [{ from: localPath, to: hookPath }],
      edits: [],
      notes: [`Restoring previous hook from ${localPath} → ${hookPath}.`],
    };
  }

  return {
    mode: 'standalone',
    removes: [hookPath],
    restores: [],
    edits: [],
    notes: [`Removing tenbo-managed standalone hook at ${hookPath}.`],
  };
}

export function applyUninstall(plan: UninstallPlan): UninstallPlan {
  for (const r of plan.removes) {
    if (fs.existsSync(r)) fs.unlinkSync(r);
  }
  for (const r of plan.restores) {
    if (fs.existsSync(r.to)) fs.unlinkSync(r.to);
    fs.renameSync(r.from, r.to);
    fs.chmodSync(r.to, 0o755);
  }
  for (const e of plan.edits) {
    fs.writeFileSync(e.path, e.after);
  }
  return plan;
}

/** Strip the husky tenbo block (between BEGIN/END markers, inclusive). Pure. */
export function stripHuskyBlock(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.includes(TENBO_HUSKY_BEGIN)) {
      inside = true;
      // Drop a single leading blank line we may have added for spacing.
      if (out.length && out[out.length - 1] === '') out.pop();
      continue;
    }
    if (line.includes(TENBO_HUSKY_END)) {
      inside = false;
      continue;
    }
    if (!inside) out.push(line);
  }
  return out.join('\n');
}

/** Pretty-print a plan for --dry-run. */
export function formatInstallPlan(plan: InstallPlan): string {
  const lines: string[] = [];
  lines.push(`Install mode: ${plan.mode}`);
  for (const n of plan.notes) lines.push(`  - ${n}`);
  for (const m of plan.moves) lines.push(`  move: ${m.from} → ${m.to}`);
  for (const w of plan.writes) lines.push(`  write: ${w.path} (${w.reason})`);
  if (plan.mode === 'already-installed') lines.push('  (no changes — already installed)');
  return lines.join('\n');
}

export function formatUninstallPlan(plan: UninstallPlan): string {
  const lines: string[] = [];
  lines.push(`Uninstall mode: ${plan.mode}`);
  for (const n of plan.notes) lines.push(`  - ${n}`);
  for (const r of plan.removes) lines.push(`  remove: ${r}`);
  for (const r of plan.restores) lines.push(`  restore: ${r.from} → ${r.to}`);
  for (const e of plan.edits) lines.push(`  edit: ${e.path}`);
  return lines.join('\n');
}

/**
 * prepare-commit-msg hook (td-025) — OPT-IN, separate install target from
 * the pre-commit validator hook above.
 *
 * On a plain interactive commit (no -m/-F, no template, no merge/squash/
 * amend) it shells out to `tenbo-dashboard commit-context --hook-format`
 * and, if that produced a suggestion, PREPENDS it as commented lines to the
 * commit message file. It never rewrites or drops the user's message, never
 * changes the exit code the commit depends on, and no-ops silently on any
 * error, timeout, or missing `.tenbo/`. Time-budgeted via a background
 * watcher that kills the suggestion command after ~5s so a slow repo can
 * never delay the commit.
 */
export const PREPARE_COMMIT_MSG_HEADER_MARKER = '# tenbo-managed prepare-commit-msg hook (td-025)';
export const PREPARE_COMMIT_MSG_HUSKY_BEGIN = '### tenbo-managed prepare-commit-msg (td-025) BEGIN ###';
export const PREPARE_COMMIT_MSG_HUSKY_END = '### tenbo-managed prepare-commit-msg (td-025) END ###';

/** Core suggestion logic, shared between the standalone body and the husky block. Relies on $1/$2 (the hook's own positional args) being in scope. */
const PREPARE_COMMIT_MSG_CORE = `# Suggests roadmap item refs + commit message context by prepending a
# commented block to the commit message. Never blocks or rewrites the
# commit: always exits 0, and no-ops silently on any error, timeout, or
# missing .tenbo/. Bypass with \`git commit --no-verify\`.

COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="$2"

# Only suggest for a plain interactive commit — skip -m/-F, templates,
# merges, squashes, and amends so we never interfere with an explicit
# message.
if [ -n "$COMMIT_SOURCE" ]; then exit 0; fi
if [ ! -d .tenbo ]; then exit 0; fi
if [ -z "$COMMIT_MSG_FILE" ] || [ ! -f "$COMMIT_MSG_FILE" ]; then exit 0; fi

RAND_SUFFIX="$(od -An -N4 -tu4 /dev/urandom 2>/dev/null | tr -d ' \\n')"
OUT_FILE="$(mktemp 2>/dev/null || echo "/tmp/tenbo-prepare-commit-msg.$$.\${RAND_SUFFIX:-0}")"

# Time-budgeted: run in the background and kill after ~5s so a slow repo
# never delays the commit. Escalates from TERM to KILL so a child that
# traps/ignores SIGTERM still can't blow the budget.
(npx --no-install tenbo-dashboard commit-context --hook-format >"$OUT_FILE" 2>/dev/null) &
CMD_PID=$!
(sleep 5; kill -TERM "$CMD_PID" 2>/dev/null; sleep 1; kill -KILL "$CMD_PID" 2>/dev/null) >/dev/null 2>&1 &
WATCHER_PID=$!
wait "$CMD_PID" 2>/dev/null
kill "$WATCHER_PID" 2>/dev/null
wait "$WATCHER_PID" 2>/dev/null

if [ -s "$OUT_FILE" ]; then
  TMP_MSG="\${COMMIT_MSG_FILE}.tenbo-tmp"
  { cat "$OUT_FILE"; echo ""; cat "$COMMIT_MSG_FILE"; } > "$TMP_MSG" && mv "$TMP_MSG" "$COMMIT_MSG_FILE"
fi

rm -f "$OUT_FILE" 2>/dev/null
exit 0
`;

/** The body of the prepare-commit-msg script the hook runs (POSIX sh, no bash-isms). */
export const PREPARE_COMMIT_MSG_HOOK_BODY = `#!/usr/bin/env sh
${PREPARE_COMMIT_MSG_HEADER_MARKER}
${PREPARE_COMMIT_MSG_CORE}`;

/** Husky-style block, appended to an existing .husky/prepare-commit-msg file. Runs with the hook's own $1/$2 in scope. */
export const PREPARE_COMMIT_MSG_HUSKY_BLOCK = `\n${PREPARE_COMMIT_MSG_HUSKY_BEGIN}
${PREPARE_COMMIT_MSG_CORE}${PREPARE_COMMIT_MSG_HUSKY_END}\n`;

/** Chained-hook body when a foreign prepare-commit-msg hook was present. Preserves the foreign hook's own exit code, then always exits 0 for the tenbo suggestion step. */
export function chainedPrepareCommitMsgBody(localHookRelPath: string): string {
  return `#!/usr/bin/env sh
${PREPARE_COMMIT_MSG_HEADER_MARKER}
# Chained install — runs the previously-installed hook first (preserving its
# exit code, so it can still block the commit if it wants), then tenbo's
# suggestion step. Uninstalling restores the local hook to its original
# location.

LOCAL_HOOK="$(dirname "$0")/${path.basename(localHookRelPath)}"
if [ -x "$LOCAL_HOOK" ]; then
  "$LOCAL_HOOK" "$@" || exit $?
fi

${PREPARE_COMMIT_MSG_CORE}`;
}

function isPrepareCommitMsgManaged(content: string): boolean {
  return content.includes(PREPARE_COMMIT_MSG_HEADER_MARKER) || content.includes(PREPARE_COMMIT_MSG_HUSKY_BEGIN);
}

/** Compute the prepare-commit-msg install plan WITHOUT touching the filesystem. Mirrors planInstall's husky/standalone/chained decision tree. */
export function planPrepareCommitMsgInstall(ctx: InstallContext): InstallPlan {
  const huskyPath = path.join(ctx.repoRoot, '.husky', 'prepare-commit-msg');
  const hookPath = path.join(ctx.repoRoot, '.git', 'hooks', 'prepare-commit-msg');

  if (fs.existsSync(huskyPath)) {
    const content = fs.readFileSync(huskyPath, 'utf8');
    if (isPrepareCommitMsgManaged(content)) {
      return {
        mode: 'already-installed',
        writes: [],
        moves: [],
        notes: [`tenbo block already present in ${huskyPath}`],
      };
    }
    return {
      mode: 'husky',
      writes: [{ path: huskyPath, reason: 'append tenbo suggestion block to existing husky prepare-commit-msg', chmod: true }],
      moves: [],
      notes: [
        `Detected husky at ${huskyPath} — appending tenbo block (delimited by ${PREPARE_COMMIT_MSG_HUSKY_BEGIN} / ${PREPARE_COMMIT_MSG_HUSKY_END}).`,
      ],
    };
  }

  if (!fs.existsSync(hookPath)) {
    return {
      mode: 'standalone',
      writes: [{ path: hookPath, reason: 'create new prepare-commit-msg hook (no existing hook found)', chmod: true }],
      moves: [],
      notes: ['No existing prepare-commit-msg hook found — installing standalone.'],
    };
  }

  const existing = fs.readFileSync(hookPath, 'utf8');
  if (isPrepareCommitMsgManaged(existing)) {
    return {
      mode: 'already-installed',
      writes: [],
      moves: [],
      notes: [`Tenbo header already present in ${hookPath}`],
    };
  }

  if (ctx.force) {
    return {
      mode: 'standalone',
      writes: [{ path: hookPath, reason: 'overwrite foreign hook (--force)', chmod: true }],
      moves: [],
      notes: [`--force: overwriting existing non-tenbo hook at ${hookPath}.`],
    };
  }

  const localPath = hookPath + '.local';
  return {
    mode: 'chained',
    writes: [{ path: hookPath, reason: 'write chained hook that runs local then tenbo suggestion', chmod: true }],
    moves: [{ from: hookPath, to: localPath }],
    notes: [
      `Existing non-tenbo hook detected at ${hookPath}.`,
      `It will be preserved at ${localPath} and chained: local hook runs first, then tenbo suggestion.`,
    ],
  };
}

/** Apply a prepare-commit-msg install plan. Returns the same plan for caller reporting. */
export function applyPrepareCommitMsgInstall(plan: InstallPlan): InstallPlan {
  for (const m of plan.moves) {
    fs.renameSync(m.from, m.to);
  }
  for (const w of plan.writes) {
    fs.mkdirSync(path.dirname(w.path), { recursive: true });
    let body: string;
    if (plan.mode === 'husky') {
      const existing = fs.existsSync(w.path) ? fs.readFileSync(w.path, 'utf8') : '';
      body = existing.endsWith('\n') ? existing + PREPARE_COMMIT_MSG_HUSKY_BLOCK : existing + '\n' + PREPARE_COMMIT_MSG_HUSKY_BLOCK;
    } else if (plan.mode === 'chained') {
      const moved = plan.moves.find((m) => m.to.endsWith('.local'));
      body = chainedPrepareCommitMsgBody(moved ? moved.to : 'prepare-commit-msg.local');
    } else {
      body = PREPARE_COMMIT_MSG_HOOK_BODY;
    }
    fs.writeFileSync(w.path, body);
    if (w.chmod) fs.chmodSync(w.path, 0o755);
  }
  return plan;
}

/** Compute the prepare-commit-msg uninstall plan. Mirrors planUninstall. */
export function planPrepareCommitMsgUninstall(repoRoot: string): UninstallPlan {
  const huskyPath = path.join(repoRoot, '.husky', 'prepare-commit-msg');
  const hookPath = path.join(repoRoot, '.git', 'hooks', 'prepare-commit-msg');
  const localPath = hookPath + '.local';

  if (fs.existsSync(huskyPath)) {
    const content = fs.readFileSync(huskyPath, 'utf8');
    if (content.includes(PREPARE_COMMIT_MSG_HUSKY_BEGIN)) {
      const after = stripPrepareCommitMsgHuskyBlock(content);
      return {
        mode: 'husky',
        removes: [],
        restores: [],
        edits: [{ path: huskyPath, before: content, after }],
        notes: [`Removing tenbo block from ${huskyPath}.`],
      };
    }
  }

  if (!fs.existsSync(hookPath)) {
    return { mode: 'not-installed', removes: [], restores: [], edits: [], notes: ['No tenbo-managed hook found.'] };
  }

  const content = fs.readFileSync(hookPath, 'utf8');
  if (!content.includes(PREPARE_COMMIT_MSG_HEADER_MARKER)) {
    return {
      mode: 'not-installed',
      removes: [],
      restores: [],
      edits: [],
      notes: [`Hook at ${hookPath} is not tenbo-managed — leaving it alone.`],
    };
  }

  if (fs.existsSync(localPath)) {
    return {
      mode: 'chained',
      removes: [],
      restores: [{ from: localPath, to: hookPath }],
      edits: [],
      notes: [`Restoring previous hook from ${localPath} → ${hookPath}.`],
    };
  }

  return {
    mode: 'standalone',
    removes: [hookPath],
    restores: [],
    edits: [],
    notes: [`Removing tenbo-managed standalone hook at ${hookPath}.`],
  };
}

export function applyPrepareCommitMsgUninstall(plan: UninstallPlan): UninstallPlan {
  for (const r of plan.removes) {
    if (fs.existsSync(r)) fs.unlinkSync(r);
  }
  for (const r of plan.restores) {
    if (fs.existsSync(r.to)) fs.unlinkSync(r.to);
    fs.renameSync(r.from, r.to);
    fs.chmodSync(r.to, 0o755);
  }
  for (const e of plan.edits) {
    fs.writeFileSync(e.path, e.after);
  }
  return plan;
}

/** Strip the husky tenbo prepare-commit-msg block (between BEGIN/END markers, inclusive). Pure. */
export function stripPrepareCommitMsgHuskyBlock(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.includes(PREPARE_COMMIT_MSG_HUSKY_BEGIN)) {
      inside = true;
      if (out.length && out[out.length - 1] === '') out.pop();
      continue;
    }
    if (line.includes(PREPARE_COMMIT_MSG_HUSKY_END)) {
      inside = false;
      continue;
    }
    if (!inside) out.push(line);
  }
  return out.join('\n');
}

/**
 * post-commit hook (td-028) — OPT-IN, separate install target from the
 * pre-commit validator and prepare-commit-msg suggestion hooks above.
 *
 * On every commit it shells out to
 * `tenbo-dashboard reconcile flag --since HEAD~1`, which maps the
 * just-made commit's diff to affected layers (via `impact`) and appends one
 * pending-reconciliation entry per affected layer to
 * `.tenbo/.pending-reconciliation.yaml` — so the next agent session's
 * briefing (`resolveSessionContext`'s `pending_reconciliation` field) sees
 * the flag. It is flag-only: it never edits docs, code-map.md, or roadmap
 * items, never invokes an LLM, and never blocks the commit (the commit has
 * already happened by the time post-commit runs, but this hook still always
 * exits 0 and no-ops silently on any error, timeout, or missing `.tenbo/`).
 * Time-budgeted via the same background watcher pattern as
 * prepare-commit-msg so a slow repo can never hang the shell after commit.
 */
export const POST_COMMIT_HEADER_MARKER = '# tenbo-managed post-commit hook (td-028)';
export const POST_COMMIT_HUSKY_BEGIN = '### tenbo-managed post-commit (td-028) BEGIN ###';
export const POST_COMMIT_HUSKY_END = '### tenbo-managed post-commit (td-028) END ###';

/** Core doc-flag logic, shared between the standalone body and the husky block. */
const POST_COMMIT_CORE = `# Maps the just-made commit's diff to affected layers (via \`impact\`) and
# appends a pending-reconciliation doc-flag entry per affected layer to
# .tenbo/.pending-reconciliation.yaml. Flag-only: never edits docs,
# code-map.md, or roadmap items, and never invokes an LLM. Always exits 0 —
# the commit has already happened, so this can never block it. Does NOT
# rebuild the source index; uses it if fresh, else falls back silently.
# Uninstall with \`tenbo-dashboard hook uninstall post-commit\`.

if [ ! -d .tenbo ]; then exit 0; fi

# Time-budgeted: run in the background and kill after ~5s so a slow repo
# never delays returning control after commit. Escalates from TERM to KILL
# so a child that traps/ignores SIGTERM still can't blow the budget.
(npx --no-install tenbo-dashboard reconcile flag --since HEAD~1 >/dev/null 2>&1) &
CMD_PID=$!
(sleep 5; kill -TERM "$CMD_PID" 2>/dev/null; sleep 1; kill -KILL "$CMD_PID" 2>/dev/null) >/dev/null 2>&1 &
WATCHER_PID=$!
wait "$CMD_PID" 2>/dev/null
kill "$WATCHER_PID" 2>/dev/null
wait "$WATCHER_PID" 2>/dev/null

exit 0
`;

/** The body of the post-commit script the hook runs (POSIX sh, no bash-isms). */
export const POST_COMMIT_HOOK_BODY = `#!/usr/bin/env sh
${POST_COMMIT_HEADER_MARKER}
${POST_COMMIT_CORE}`;

/** Husky-style block, appended to an existing .husky/post-commit file. */
export const POST_COMMIT_HUSKY_BLOCK = `\n${POST_COMMIT_HUSKY_BEGIN}
${POST_COMMIT_CORE}${POST_COMMIT_HUSKY_END}\n`;

/** Chained-hook body when a foreign post-commit hook was present. post-commit's exit code is advisory (git ignores it — the commit already landed), but the local hook still runs first for parity with the other hook kinds. */
export function chainedPostCommitBody(localHookRelPath: string): string {
  return `#!/usr/bin/env sh
${POST_COMMIT_HEADER_MARKER}
# Chained install — runs the previously-installed hook first, then tenbo's
# doc-flag step. Uninstalling restores the local hook to its original
# location.

LOCAL_HOOK="$(dirname "$0")/${path.basename(localHookRelPath)}"
if [ -x "$LOCAL_HOOK" ]; then
  "$LOCAL_HOOK" "$@"
fi

${POST_COMMIT_CORE}`;
}

function isPostCommitManaged(content: string): boolean {
  return content.includes(POST_COMMIT_HEADER_MARKER) || content.includes(POST_COMMIT_HUSKY_BEGIN);
}

/** Compute the post-commit install plan WITHOUT touching the filesystem. Mirrors planPrepareCommitMsgInstall's husky/standalone/chained decision tree. */
export function planPostCommitInstall(ctx: InstallContext): InstallPlan {
  const huskyPath = path.join(ctx.repoRoot, '.husky', 'post-commit');
  const hookPath = path.join(ctx.repoRoot, '.git', 'hooks', 'post-commit');

  if (fs.existsSync(huskyPath)) {
    const content = fs.readFileSync(huskyPath, 'utf8');
    if (isPostCommitManaged(content)) {
      return {
        mode: 'already-installed',
        writes: [],
        moves: [],
        notes: [`tenbo block already present in ${huskyPath}`],
      };
    }
    return {
      mode: 'husky',
      writes: [{ path: huskyPath, reason: 'append tenbo doc-flag block to existing husky post-commit', chmod: true }],
      moves: [],
      notes: [
        `Detected husky at ${huskyPath} — appending tenbo block (delimited by ${POST_COMMIT_HUSKY_BEGIN} / ${POST_COMMIT_HUSKY_END}).`,
      ],
    };
  }

  if (!fs.existsSync(hookPath)) {
    return {
      mode: 'standalone',
      writes: [{ path: hookPath, reason: 'create new post-commit hook (no existing hook found)', chmod: true }],
      moves: [],
      notes: ['No existing post-commit hook found — installing standalone.'],
    };
  }

  const existing = fs.readFileSync(hookPath, 'utf8');
  if (isPostCommitManaged(existing)) {
    return {
      mode: 'already-installed',
      writes: [],
      moves: [],
      notes: [`Tenbo header already present in ${hookPath}`],
    };
  }

  if (ctx.force) {
    return {
      mode: 'standalone',
      writes: [{ path: hookPath, reason: 'overwrite foreign hook (--force)', chmod: true }],
      moves: [],
      notes: [`--force: overwriting existing non-tenbo hook at ${hookPath}.`],
    };
  }

  const localPath = hookPath + '.local';
  return {
    mode: 'chained',
    writes: [{ path: hookPath, reason: 'write chained hook that runs local then tenbo doc-flag step', chmod: true }],
    moves: [{ from: hookPath, to: localPath }],
    notes: [
      `Existing non-tenbo hook detected at ${hookPath}.`,
      `It will be preserved at ${localPath} and chained: local hook runs first, then tenbo doc-flag step.`,
    ],
  };
}

/** Apply a post-commit install plan. Returns the same plan for caller reporting. */
export function applyPostCommitInstall(plan: InstallPlan): InstallPlan {
  for (const m of plan.moves) {
    fs.renameSync(m.from, m.to);
  }
  for (const w of plan.writes) {
    fs.mkdirSync(path.dirname(w.path), { recursive: true });
    let body: string;
    if (plan.mode === 'husky') {
      const existing = fs.existsSync(w.path) ? fs.readFileSync(w.path, 'utf8') : '';
      body = existing.endsWith('\n') ? existing + POST_COMMIT_HUSKY_BLOCK : existing + '\n' + POST_COMMIT_HUSKY_BLOCK;
    } else if (plan.mode === 'chained') {
      const moved = plan.moves.find((m) => m.to.endsWith('.local'));
      body = chainedPostCommitBody(moved ? moved.to : 'post-commit.local');
    } else {
      body = POST_COMMIT_HOOK_BODY;
    }
    fs.writeFileSync(w.path, body);
    if (w.chmod) fs.chmodSync(w.path, 0o755);
  }
  return plan;
}

/** Compute the post-commit uninstall plan. Mirrors planPrepareCommitMsgUninstall. */
export function planPostCommitUninstall(repoRoot: string): UninstallPlan {
  const huskyPath = path.join(repoRoot, '.husky', 'post-commit');
  const hookPath = path.join(repoRoot, '.git', 'hooks', 'post-commit');
  const localPath = hookPath + '.local';

  if (fs.existsSync(huskyPath)) {
    const content = fs.readFileSync(huskyPath, 'utf8');
    if (content.includes(POST_COMMIT_HUSKY_BEGIN)) {
      const after = stripPostCommitHuskyBlock(content);
      return {
        mode: 'husky',
        removes: [],
        restores: [],
        edits: [{ path: huskyPath, before: content, after }],
        notes: [`Removing tenbo block from ${huskyPath}.`],
      };
    }
  }

  if (!fs.existsSync(hookPath)) {
    return { mode: 'not-installed', removes: [], restores: [], edits: [], notes: ['No tenbo-managed hook found.'] };
  }

  const content = fs.readFileSync(hookPath, 'utf8');
  if (!content.includes(POST_COMMIT_HEADER_MARKER)) {
    return {
      mode: 'not-installed',
      removes: [],
      restores: [],
      edits: [],
      notes: [`Hook at ${hookPath} is not tenbo-managed — leaving it alone.`],
    };
  }

  if (fs.existsSync(localPath)) {
    return {
      mode: 'chained',
      removes: [],
      restores: [{ from: localPath, to: hookPath }],
      edits: [],
      notes: [`Restoring previous hook from ${localPath} → ${hookPath}.`],
    };
  }

  return {
    mode: 'standalone',
    removes: [hookPath],
    restores: [],
    edits: [],
    notes: [`Removing tenbo-managed standalone hook at ${hookPath}.`],
  };
}

export function applyPostCommitUninstall(plan: UninstallPlan): UninstallPlan {
  for (const r of plan.removes) {
    if (fs.existsSync(r)) fs.unlinkSync(r);
  }
  for (const r of plan.restores) {
    if (fs.existsSync(r.to)) fs.unlinkSync(r.to);
    fs.renameSync(r.from, r.to);
    fs.chmodSync(r.to, 0o755);
  }
  for (const e of plan.edits) {
    fs.writeFileSync(e.path, e.after);
  }
  return plan;
}

/** Strip the husky tenbo post-commit block (between BEGIN/END markers, inclusive). Pure. */
export function stripPostCommitHuskyBlock(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.includes(POST_COMMIT_HUSKY_BEGIN)) {
      inside = true;
      if (out.length && out[out.length - 1] === '') out.pop();
      continue;
    }
    if (line.includes(POST_COMMIT_HUSKY_END)) {
      inside = false;
      continue;
    }
    if (!inside) out.push(line);
  }
  return out.join('\n');
}

function isMain(): boolean {
  try {
    const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const here = path.resolve(new URL(import.meta.url).pathname);
    return invoked === here;
  } catch {
    return false;
  }
}

function printHelp(): void {
  process.stdout.write(`tenbo-dashboard hook — opt-in git hooks (sk-032, td-025, td-028)

Usage:
  tenbo-dashboard hook install [pre-commit|prepare-commit-msg|post-commit] [--dry-run] [--force]
  tenbo-dashboard hook uninstall [pre-commit|prepare-commit-msg|post-commit]
  tenbo-dashboard hook status [pre-commit|prepare-commit-msg|post-commit]

Hook kind defaults to pre-commit when omitted. All three are OPT-IN and
independent — installing one does not install the others.

pre-commit (sk-032): runs the deterministic validator on .tenbo/ at commit
time. Errors block commit; warnings print but don't block.

prepare-commit-msg (td-025): proposes roadmap item refs by prepending a
commented suggestion block to the commit message. Never blocks or rewrites
the commit — always exits 0, no-ops silently on any error or timeout.

post-commit (td-028): maps the just-made commit's diff to affected layers
(via \`impact --since HEAD~1\`) and appends a pending-reconciliation doc-flag
entry per affected layer to .tenbo/.pending-reconciliation.yaml, so the next
agent session's briefing surfaces it. Flag-only — never edits docs or
roadmap items, never invokes an LLM, always exits 0.

Bypass per-commit with \`git commit --no-verify\`.

Flags:
  --dry-run   Print exactly what would change without writing.
  --force     Overwrite an existing non-tenbo hook (use with care).

Notes:
  - An existing foreign hook file is preserved via chained-hook pattern.
  - .husky/<hook> users get a delimited block appended (no .git/hooks/ touch).
  - Re-running install after install is a no-op.
`);
}

type HookKind = 'pre-commit' | 'prepare-commit-msg' | 'post-commit';

function parseHookKind(args: string[]): HookKind | 'invalid' {
  const candidate = args[1];
  if (!candidate || candidate.startsWith('--')) return 'pre-commit';
  if (candidate === 'pre-commit' || candidate === 'prepare-commit-msg' || candidate === 'post-commit') return candidate;
  return 'invalid';
}

function planInstallForKind(kind: HookKind, ctx: InstallContext): InstallPlan {
  if (kind === 'prepare-commit-msg') return planPrepareCommitMsgInstall(ctx);
  if (kind === 'post-commit') return planPostCommitInstall(ctx);
  return planInstall(ctx);
}

function applyInstallForKind(kind: HookKind, plan: InstallPlan): InstallPlan {
  if (kind === 'prepare-commit-msg') return applyPrepareCommitMsgInstall(plan);
  if (kind === 'post-commit') return applyPostCommitInstall(plan);
  return applyInstall(plan);
}

function planUninstallForKind(kind: HookKind, repoRoot: string): UninstallPlan {
  if (kind === 'prepare-commit-msg') return planPrepareCommitMsgUninstall(repoRoot);
  if (kind === 'post-commit') return planPostCommitUninstall(repoRoot);
  return planUninstall(repoRoot);
}

function applyUninstallForKind(kind: HookKind, plan: UninstallPlan): UninstallPlan {
  if (kind === 'prepare-commit-msg') return applyPrepareCommitMsgUninstall(plan);
  if (kind === 'post-commit') return applyPostCommitUninstall(plan);
  return applyUninstall(plan);
}

if (isMain()) {
  const args = process.argv.slice(2);
  const action = args[0];
  const cwd = process.cwd();
  const repoRoot = findRepoRoot(cwd);

  if (!action || action === 'help' || action === '--help') {
    printHelp();
    process.exit(0);
  }

  if (!repoRoot) {
    process.stderr.write('hook: not inside a git repository (no .git/ found in any parent).\n');
    process.exit(1);
  }

  const kind = parseHookKind(args);
  if (kind === 'invalid') {
    process.stderr.write(`hook: unknown hook kind '${args[1]}'. Expected 'pre-commit', 'prepare-commit-msg', or 'post-commit'.\n`);
    process.exit(2);
  }

  if (action === 'install') {
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');
    const plan = planInstallForKind(kind, { repoRoot, force });
    if (dryRun) {
      process.stdout.write(formatInstallPlan(plan) + '\n');
      process.stdout.write('(dry-run — no changes written)\n');
      process.exit(0);
    }
    if (plan.mode === 'already-installed') {
      process.stdout.write(`tenbo ${kind} hook already installed. No changes.\n`);
      process.exit(0);
    }
    applyInstallForKind(kind, plan);
    process.stdout.write(formatInstallPlan(plan) + '\n');
    process.stdout.write(`Installed. Bypass with \`git commit --no-verify\`. Uninstall with \`npx tenbo-dashboard hook uninstall ${kind}\`.\n`);
    process.exit(0);
  }

  if (action === 'uninstall') {
    const plan = planUninstallForKind(kind, repoRoot);
    if (plan.mode === 'not-installed') {
      process.stdout.write(`No tenbo-managed ${kind} hook found. Nothing to do.\n`);
      process.exit(0);
    }
    applyUninstallForKind(kind, plan);
    process.stdout.write(formatUninstallPlan(plan) + '\n');
    process.stdout.write('Uninstalled.\n');
    process.exit(0);
  }

  if (action === 'status') {
    const plan = planInstallForKind(kind, { repoRoot });
    process.stdout.write(`hook status (${kind}): ${plan.mode === 'already-installed' ? 'installed' : 'not installed'}\n`);
    for (const n of plan.notes) process.stdout.write(`  - ${n}\n`);
    process.exit(0);
  }

  process.stderr.write(`hook: unknown action '${action}'. Run \`tenbo-dashboard hook help\`.\n`);
  process.exit(2);
}
