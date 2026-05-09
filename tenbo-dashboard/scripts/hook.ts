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
  process.stdout.write(`tenbo-dashboard hook — opt-in pre-commit hook (sk-032)

Usage:
  tenbo-dashboard hook install [--dry-run] [--force]
  tenbo-dashboard hook uninstall
  tenbo-dashboard hook status

Install runs the deterministic validator on .tenbo/ at commit time.
Errors block commit; warnings print but don't block.
Bypass per-commit with \`git commit --no-verify\`.

Flags:
  --dry-run   Print exactly what would change without writing.
  --force     Overwrite an existing non-tenbo hook (use with care).

Notes:
  - Existing .git/hooks/pre-commit (foreign) is preserved via chained-hook pattern.
  - .husky/pre-commit users get a delimited block appended (no .git/hooks/ touch).
  - Re-running install after install is a no-op.
`);
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

  if (action === 'install') {
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');
    const plan = planInstall({ repoRoot, force });
    if (dryRun) {
      process.stdout.write(formatInstallPlan(plan) + '\n');
      process.stdout.write('(dry-run — no changes written)\n');
      process.exit(0);
    }
    if (plan.mode === 'already-installed') {
      process.stdout.write('tenbo pre-commit hook already installed. No changes.\n');
      process.exit(0);
    }
    applyInstall(plan);
    process.stdout.write(formatInstallPlan(plan) + '\n');
    process.stdout.write('Installed. Bypass with `git commit --no-verify`. Uninstall with `npx tenbo-dashboard hook uninstall`.\n');
    process.exit(0);
  }

  if (action === 'uninstall') {
    const plan = planUninstall(repoRoot);
    if (plan.mode === 'not-installed') {
      process.stdout.write('No tenbo-managed pre-commit hook found. Nothing to do.\n');
      process.exit(0);
    }
    applyUninstall(plan);
    process.stdout.write(formatUninstallPlan(plan) + '\n');
    process.stdout.write('Uninstalled.\n');
    process.exit(0);
  }

  if (action === 'status') {
    const plan = planInstall({ repoRoot });
    process.stdout.write(`hook status: ${plan.mode === 'already-installed' ? 'installed' : 'not installed'}\n`);
    for (const n of plan.notes) process.stdout.write(`  - ${n}\n`);
    process.exit(0);
  }

  process.stderr.write(`hook: unknown action '${action}'. Run \`tenbo-dashboard hook help\`.\n`);
  process.exit(2);
}
