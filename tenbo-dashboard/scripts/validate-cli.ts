/**
 * validate-cli.ts — tenbo validator CLI with diff-based output.
 *
 * Default output: summarizes NEW errors / warnings vs the previous run's
 *   `.tenbo/.validation-status.json` snapshot. Pre-existing findings are rolled
 *   into a single summary line so the signal is the diff, not the absolute set.
 * --verbose: full list of every finding (the historical behavior).
 * --json:    full snapshot to stdout for CI consumers.
 *
 * The `.validation-status.json` schema is unchanged; only presentation changes.
 */
import { findRepoRoot } from '../src/api/lib/repoRoot';
import { readState } from '../src/api/lib/tenboFs';
import { validate } from '../src/api/lib/validator';
import type { ValidateIssue } from '../src/types';
import fs from 'node:fs';
import path from 'node:path';

interface Snapshot {
  generated_at: string;
  errors: ValidateIssue[];
  warnings: ValidateIssue[];
}

interface DiffResult {
  newErrors: ValidateIssue[];
  preExistingErrors: ValidateIssue[];
  newWarnings: ValidateIssue[];
  preExistingWarnings: ValidateIssue[];
}

/** Stable hash for an issue: message + scope + (itemId|layerId). */
export function issueKey(i: ValidateIssue): string {
  const target = (i.itemId ?? '') + '::' + (i.layerId ?? '');
  return `${i.message}||${i.scope ?? ''}||${target}`;
}

export function computeDiff(prev: Snapshot | null, current: Snapshot): DiffResult {
  const prevErr = new Set((prev?.errors ?? []).map(issueKey));
  const prevWarn = new Set((prev?.warnings ?? []).map(issueKey));
  const newErrors: ValidateIssue[] = [];
  const preExistingErrors: ValidateIssue[] = [];
  const newWarnings: ValidateIssue[] = [];
  const preExistingWarnings: ValidateIssue[] = [];
  for (const e of current.errors) (prevErr.has(issueKey(e)) ? preExistingErrors : newErrors).push(e);
  for (const w of current.warnings) (prevWarn.has(issueKey(w)) ? preExistingWarnings : newWarnings).push(w);
  return { newErrors, preExistingErrors, newWarnings, preExistingWarnings };
}

export interface RenderOptions {
  verbose?: boolean;
  json?: boolean;
}

export interface RenderResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Pure renderer — testable without spawning a process. */
export function renderOutput(snapshot: Snapshot, diff: DiffResult, opts: RenderOptions): RenderResult {
  const out: string[] = [];
  const err: string[] = [];

  if (opts.json) {
    out.push(JSON.stringify(snapshot, null, 2));
    return {
      stdout: out.join('\n') + '\n',
      stderr: '',
      exitCode: snapshot.errors.length ? 1 : 0,
    };
  }

  if (opts.verbose) {
    if (snapshot.errors.length) {
      err.push('tenbo validation FAILED:');
      for (const e of snapshot.errors) err.push(`  ❌ ${e.message}`);
    } else {
      out.push('tenbo validation: no errors.');
    }
    if (snapshot.warnings.length) {
      const lines: string[] = [];
      lines.push(`tenbo validation warnings (${snapshot.warnings.length}):`);
      for (const w of snapshot.warnings) lines.push(`  ⚠️ ${w.message}`);
      (snapshot.errors.length ? err : out).push(lines.join('\n'));
    }
    return {
      stdout: out.join('\n') + (out.length ? '\n' : ''),
      stderr: err.join('\n') + (err.length ? '\n' : ''),
      exitCode: snapshot.errors.length ? 1 : 0,
    };
  }

  // Default: diff-based summary.
  const { newErrors, preExistingErrors, newWarnings, preExistingWarnings } = diff;
  const totalErrors = newErrors.length + preExistingErrors.length;
  const totalWarnings = newWarnings.length + preExistingWarnings.length;

  if (newErrors.length === 0 && newWarnings.length === 0) {
    out.push(
      `tenbo validation passed (${totalErrors} errors, ${totalWarnings} warnings — all pre-existing). Run with --verbose to list.`,
    );
    return { stdout: out.join('\n') + '\n', stderr: '', exitCode: 0 };
  }

  if (newErrors.length > 0) {
    err.push(`tenbo validation FAILED — ${newErrors.length} new error(s):`);
    for (const e of newErrors) err.push(`  ❌ ${e.message}`);
    err.push('');
    err.push(
      `Summary: ${newErrors.length} new errors, ${preExistingErrors.length} pre-existing errors, ${newWarnings.length} new warnings, ${preExistingWarnings.length} pre-existing warnings. Run with --verbose to list everything.`,
    );
    return { stdout: '', stderr: err.join('\n') + '\n', exitCode: 1 };
  }

  // newErrors === 0, newWarnings > 0
  out.push(`tenbo validation passed with ${newWarnings.length} new warning(s):`);
  for (const w of newWarnings) out.push(`  ⚠️ ${w.message}`);
  out.push('');
  out.push(
    `Summary: 0 new errors, ${preExistingErrors.length} pre-existing errors, ${newWarnings.length} new warnings, ${preExistingWarnings.length} pre-existing warnings. Run with --verbose to list everything.`,
  );
  return { stdout: out.join('\n') + '\n', stderr: '', exitCode: 0 };
}

function readPrevSnapshot(statusPath: string): Snapshot | null {
  if (!fs.existsSync(statusPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    return {
      generated_at: raw.generated_at ?? '',
      errors: Array.isArray(raw.errors) ? raw.errors : [],
      warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    };
  } catch {
    return null;
  }
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

if (isMain()) {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const json = args.includes('--json');

  const cwd = process.cwd();
  const repoRoot = findRepoRoot(cwd) ?? path.resolve(cwd, '..', '..');
  const statusPath = path.join(repoRoot, '.tenbo', '.validation-status.json');
  const prev = readPrevSnapshot(statusPath);

  const state = readState(repoRoot);
  const result = validate(state);
  const snapshot: Snapshot = {
    generated_at: new Date().toISOString(),
    errors: result.errors,
    warnings: result.warnings,
  };

  fs.writeFileSync(statusPath, JSON.stringify(snapshot, null, 2) + '\n');

  const diff = computeDiff(prev, snapshot);
  const rendered = renderOutput(snapshot, diff, { verbose, json });
  if (rendered.stdout) process.stdout.write(rendered.stdout);
  if (rendered.stderr) process.stderr.write(rendered.stderr);
  if (!json && !verbose) {
    // Add a trailing pointer to where the snapshot was written, to stderr so it
    // doesn't pollute callers parsing stdout.
    process.stderr.write(`(snapshot at ${path.relative(repoRoot, statusPath)})\n`);
  }
  process.exit(rendered.exitCode);
}
