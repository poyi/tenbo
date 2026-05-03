import { ensureFresh } from '../src/api/lib/metricsRefresh.js';
import { readState } from '../src/api/lib/tenboFs.js';
import { findRepoRoot } from '../src/api/lib/repoRoot.js';

export interface RunArgs {
  repoRoot: string;
  scope?: string;
  all?: boolean;
}

export async function runComputeMetrics(args: RunArgs): Promise<number> {
  const { repoRoot } = args;
  const state = readState(repoRoot);
  const scopes = args.all
    ? state.scopes.map((s) => s.id)
    : args.scope
      ? [args.scope]
      : [];
  if (scopes.length === 0) {
    console.error('compute-metrics: pass --all or --scope <id>');
    return 2;
  }
  for (const id of scopes) {
    try {
      await ensureFresh(repoRoot, id, { force: true });
      console.log(`compute-metrics: wrote metrics for ${id}`);
    } catch (e) {
      console.error(`compute-metrics: failed for ${id}:`, e);
      return 1;
    }
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const scopeIdx = args.indexOf('--scope');
  const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : undefined;
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error('compute-metrics: unable to find repo root');
    process.exit(1);
  }
  runComputeMetrics({ repoRoot, scope, all }).then((code) => process.exit(code));
}
