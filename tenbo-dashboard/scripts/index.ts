import { buildSourceIndex } from '../src/api/lib/sourceIndex/build';
import { checkSourceIndexFreshness, readSourceIndex, writeSourceIndex } from '../src/api/lib/sourceIndex/store';
import { hasFlag } from './cliArgs';
import { handleCliError, isMain, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

export function runIndexCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const ifStale = hasFlag(args, '--if-stale');
  try {
    const existing = readSourceIndex(repoRoot);
    const before = checkSourceIndexFreshness(repoRoot, existing);
    if (ifStale && before.status === 'fresh' && existing) {
      return serialize({
        ok: true,
        mode: 'reuse',
        freshness: before,
        files: existing.files.length,
        layers: existing.layers.length,
        warnings: existing.warnings,
      }, json, `source index fresh (${existing.files.length} file(s))\n`);
    }

    const index = buildSourceIndex(repoRoot);
    writeSourceIndex(repoRoot, index);
    const freshness = checkSourceIndexFreshness(repoRoot, index);
    return serialize({
      ok: true,
      mode: 'rebuild',
      freshness,
      files: index.files.length,
      layers: index.layers.length,
      warnings: index.warnings,
    }, json, `source index rebuilt (${index.files.length} file(s))\n`);
  } catch (err) {
    return handleCliError(err, json);
  }
}

if (isMain(import.meta.url)) {
  runMain(runIndexCli(repoRootFromCwd(), process.argv.slice(2)));
}
