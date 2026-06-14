import { listNextItems } from '../src/api/lib/roadmapStore';
import { handleCliError, isMain, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

export function runNextCli(repoRoot: string, args: string[]): CliResult {
  const json = args.includes('--json');
  try {
    const items = listNextItems(repoRoot);
    return serialize({ ok: true, items }, json, `${items.map((entry) => `${entry.item.id} ${entry.item.status} ${entry.item.title}`).join('\n')}${items.length ? '\n' : ''}`);
  } catch (err) {
    return handleCliError(err, json);
  }
}

if (isMain(import.meta.url)) {
  runMain(runNextCli(repoRootFromCwd(), process.argv.slice(2)));
}
