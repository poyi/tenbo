import { listItems, type ListItemFilters } from '../src/api/lib/roadmapStore';
import { fail, handleCliError, isMain, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readOption(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

export function runItemsCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const filters: ListItemFilters = {
    status: readOption(args, '--status') as ListItemFilters['status'],
    verification: readOption(args, '--verification') as ListItemFilters['verification'],
    goal: readOption(args, '--goal'),
  };
  try {
    const items = listItems(repoRoot, filters);
    return serialize({ ok: true, items }, json, `${items.map((entry) => `${entry.item.id} ${entry.item.status} ${entry.item.title}`).join('\n')}${items.length ? '\n' : ''}`);
  } catch (err) {
    return handleCliError(err, json);
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    runMain(fail('invalid_args', 'Usage: tenbo items [--status <status>] [--verification <status>] [--goal <goal>] [--json]', false));
  }
  runMain(runItemsCli(repoRootFromCwd(), args));
}
