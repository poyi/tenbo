import { findRepoRoot } from '../src/api/lib/repoRoot';
import { isRoadmapStoreError } from '../src/api/lib/roadmapStore';

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function ok(stdout: string): CliResult {
  return { stdout, stderr: '', exitCode: 0 };
}

export function fail(error: string, message: string, json: boolean, retryable = false, exitCode = 1): CliResult {
  if (json) {
    return {
      stdout: '',
      stderr: `${JSON.stringify({ ok: false, error, message, retryable })}\n`,
      exitCode,
    };
  }
  return { stdout: '', stderr: `${message}\n`, exitCode };
}

export function misuse(message: string, json: boolean): CliResult {
  return fail('invalid_args', message, json, false, 2);
}

export function serialize(payload: unknown, json: boolean, text: string): CliResult {
  return ok(json ? `${JSON.stringify(payload, null, 2)}\n` : text);
}

export function handleCliError(err: unknown, json: boolean): CliResult {
  if (isRoadmapStoreError(err)) {
    return fail(err.code, err.message, json, err.retryable);
  }
  const message = err instanceof Error ? err.message : String(err);
  return fail('error', message, json);
}

export function repoRootFromCwd(cwd = process.cwd()): string {
  return findRepoRoot(cwd) ?? cwd;
}

export function runMain(result: CliResult): void {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

export function isMain(importMetaUrl: string): boolean {
  try {
    const invoked = process.argv[1] ? new URL(`file://${process.argv[1]}`).pathname : '';
    const here = new URL(importMetaUrl).pathname;
    return invoked === here;
  } catch {
    return false;
  }
}
