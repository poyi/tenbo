import { listNextItems } from '../src/api/lib/roadmapStore';
import { summarizeItem } from '../src/api/lib/itemProjection';
import { hasFlag } from './cliArgs';
import { handleCliError, isMain, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

export function runNextCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const agentSummary = hasFlag(args, '--agent-summary');
  try {
    const items = listNextItems(repoRoot);
    if (agentSummary) {
      const projected = items.map((entry) => summarizeItem(entry));
      return serialize({
        ok: true,
        recommended_sequence: projected.map((item) => item.id),
        items: projected,
        verification: projected.map((item) => ({
          id: item.id,
          commands: [
            `tenbo-dashboard item brief ${item.id} --json`,
            `tenbo-dashboard item verify ${item.id} --check --json`,
          ],
        })),
      }, json, `${projected.map((entry) => `${entry.id} ${entry.status} ${entry.title}`).join('\n')}${projected.length ? '\n' : ''}`);
    }
    return serialize({ ok: true, items }, json, `${items.map((entry) => `${entry.item.id} ${entry.item.status} ${entry.item.title}`).join('\n')}${items.length ? '\n' : ''}`);
  } catch (err) {
    return handleCliError(err, json);
  }
}

if (isMain(import.meta.url)) {
  runMain(runNextCli(repoRootFromCwd(), process.argv.slice(2)));
}
