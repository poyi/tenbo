/**
 * sync.ts — single command for "make tenbo state fresh after a change".
 *
 * Runs metrics --all (or --scope <id>) + init-check + validate, then prints
 * a unified summary of NEW findings (severity >= warning) introduced since
 * the prior metrics.json snapshot. Replaces three separate commands the
 * skill used to invoke at init and completion time, eliminating the
 * silent-staleness failure mode where an agent forgot one of the three.
 *
 * Exit codes:
 *   0 — everything refreshed cleanly, no new errors
 *   1 — an error in any step (validation failure, init defect, metrics throw)
 *   2 — could not locate repo root
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../src/api/lib/repoRoot';
import { runComputeMetrics } from './compute-metrics';
import { runInitCheck } from './init-check';
import { readState } from '../src/api/lib/tenboFs';
import { validate } from '../src/api/lib/validator';
import type { ScopeMetrics } from '../src/types';

interface NewFinding {
  scope: string;
  layer: string;
  severity: string;
  signal: string;
  headline: string;
}

function readMetrics(metricsPath: string): ScopeMetrics | null {
  try {
    if (!fs.existsSync(metricsPath)) return null;
    return JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  } catch {
    return null;
  }
}

function findingKey(scope: string, f: { signal: string; layer: string; headline: string }): string {
  return `${scope}::${f.signal}::${f.layer}::${f.headline}`;
}

interface SyncArgs {
  repoRoot: string;
  scope?: string; // single-scope refresh; omit to refresh all
}

export interface IndexRefreshResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_INDEX_BUDGET_MS = 3000;

function dashboardBinPath(): string {
  const here = new URL(import.meta.url);
  if (here.protocol === 'file:') return fileURLToPath(new URL('../bin/tenbo-dashboard.mjs', here));
  return path.resolve(process.cwd(), 'bin/tenbo-dashboard.mjs');
}

type SpawnSyncFn = typeof spawnSync;

export function runIndexRefreshForSync(
  repoRoot: string,
  budgetMs = DEFAULT_INDEX_BUDGET_MS,
  spawn: SpawnSyncFn = spawnSync,
): IndexRefreshResult {
  const binPath = dashboardBinPath();
  const child = spawn(process.execPath, [binPath, 'index', '--if-stale', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: budgetMs,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (child.error) {
    const code = (child.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      return {
        exitCode: 0,
        stdout: child.stdout ?? '',
        stderr: `sync: source index refresh timed out after ${budgetMs}ms; continuing without fresh index\n`,
      };
    }
    return {
      exitCode: 1,
      stdout: child.stdout ?? '',
      stderr: child.stderr || `${child.error.message}\n`,
    };
  }

  return {
    exitCode: child.status ?? (child.signal ? 1 : 0),
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? '',
  };
}

export async function runSync(args: SyncArgs): Promise<number> {
  const { repoRoot, scope } = args;

  // Snapshot prior findings so we can diff after the refresh.
  const state = readState(repoRoot);
  const targetScopes = scope ? [scope] : state.scopes.map((s) => s.id);
  const priorFindingKeys = new Set<string>();
  for (const id of targetScopes) {
    const m = readMetrics(path.join(repoRoot, '.tenbo', 'scopes', id, 'metrics.json'));
    for (const f of m?.findings ?? []) priorFindingKeys.add(findingKey(id, f));
  }

  // 1. source index (fail-open; metrics can still refresh without graph findings)
  const indexResult = runIndexRefreshForSync(repoRoot);
  if (indexResult.stderr) process.stderr.write(indexResult.stderr);
  if (indexResult.exitCode !== 0) {
    process.stderr.write('sync: source index refresh failed-open; continuing without fresh index\n');
  }

  // 2. metrics
  const metricsCode = await runComputeMetrics({
    repoRoot,
    all: !scope,
    scope,
  });
  if (metricsCode !== 0) {
    process.stderr.write('sync: metrics step failed\n');
    return 1;
  }

  // 3. init-check
  const { defects } = runInitCheck(repoRoot);
  if (defects.length > 0) {
    process.stderr.write(`sync: init-check FAILED — ${defects.length} init defect(s):\n`);
    for (const d of defects) {
      const loc = d.scope ? ` [${d.scope}${d.layerId ? `/${d.layerId}` : ''}]` : '';
      process.stderr.write(`  ❌${loc} ${d.message}\n`);
    }
    return 1;
  }

  // 4. validate (re-read state after metrics may have changed scope dirs)
  const stateAfter = readState(repoRoot);
  const result = validate(stateAfter);
  if (result.errors.length > 0) {
    process.stderr.write(`sync: validate FAILED — ${result.errors.length} error(s):\n`);
    for (const e of result.errors) process.stderr.write(`  ❌ ${e.message}\n`);
    return 1;
  }

  // 5. Diff findings: surface NEW critical/warning findings introduced this run.
  const newFindings: NewFinding[] = [];
  for (const id of targetScopes) {
    const m = readMetrics(path.join(repoRoot, '.tenbo', 'scopes', id, 'metrics.json'));
    for (const f of m?.findings ?? []) {
      if (f.severity === 'info') continue;
      if (priorFindingKeys.has(findingKey(id, f))) continue;
      newFindings.push({
        scope: id,
        layer: f.layer,
        severity: f.severity,
        signal: f.signal,
        headline: f.headline,
      });
    }
  }

  // 6. Summary line + (optional) new-finding lines.
  const scopeLabel = scope ? `scope "${scope}"` : `${targetScopes.length} scope(s)`;
  if (newFindings.length === 0) {
    process.stdout.write(`sync: ${scopeLabel} fresh. No new errors, no new warning/critical findings.\n`);
    return 0;
  }
  process.stdout.write(`sync: ${scopeLabel} fresh. ${newFindings.length} new finding(s) since last refresh:\n`);
  for (const f of newFindings) {
    const icon = f.severity === 'critical' ? '🔴' : '⚠️';
    process.stdout.write(`  ${icon} [${f.scope}/${f.layer}] ${f.signal}: ${f.headline}\n`);
  }
  return 0;
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
  const scopeIdx = args.indexOf('--scope');
  const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : undefined;
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    process.stderr.write('sync: unable to find repo root (no .git in any parent directory)\n');
    process.exit(2);
  }
  runSync({ repoRoot, scope }).then((code) => process.exit(code));
}
