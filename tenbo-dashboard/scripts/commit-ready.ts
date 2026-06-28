import { spawnSync } from 'node:child_process';
import { readState } from '../src/api/lib/tenboFs';
import { validate } from '../src/api/lib/validator';
import { hasFlag } from './cliArgs';
import { handleCliError, isMain, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

function runGit(repoRoot: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseStatus(stdout: string): { current: string | null; upstream?: string; dirtyFiles: string[] } {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const header = lines[0] ?? '';
  const unbornMatch = header.match(/^## No commits yet on (.+)$/);
  if (unbornMatch) {
    return {
      current: unbornMatch[1],
      dirtyFiles: lines.slice(1),
    };
  }
  const branchMatch = header.match(/^## ([^.\s]+)(?:\.\.\.([^\s]+))?/);
  return {
    current: branchMatch?.[1] ?? null,
    ...(branchMatch?.[2] ? { upstream: branchMatch[2] } : {}),
    dirtyFiles: lines.slice(1),
  };
}

export function runCommitReadyCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  try {
    const status = runGit(repoRoot, ['status', '--short', '--branch']);
    const parsed = parseStatus(status.stdout);
    const diffCheck = runGit(repoRoot, ['diff', '--check']);
    const staged = runGit(repoRoot, ['diff', '--cached', '--name-only']);
    const validation = validate(readState(repoRoot));
    const payload = {
      ok: true,
      branch: {
        current: parsed.current,
        upstream: parsed.upstream ?? null,
      },
      dirty_files: parsed.dirtyFiles,
      staged_files: staged.stdout.split(/\r?\n/).filter(Boolean),
      diff_check: diffCheck,
      validation: {
        errors: validation.errors.length,
        warnings: validation.warnings.length,
      },
      recommended_gates: [
        'git diff --check',
        'tenbo-dashboard validate',
        'git diff --cached --check',
      ],
    };
    return serialize(payload, json, `branch: ${payload.branch.current ?? 'unknown'}\ndirty files: ${payload.dirty_files.length}\nvalidation: ${payload.validation.errors} errors, ${payload.validation.warnings} warnings\n`);
  } catch (err) {
    return handleCliError(err, json);
  }
}

if (isMain(import.meta.url)) {
  runMain(runCommitReadyCli(repoRootFromCwd(), process.argv.slice(2)));
}
