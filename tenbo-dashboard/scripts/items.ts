import { listItems, type ListItemFilters } from '../src/api/lib/roadmapStore';
import { parseItemFields, projectItem, summarizeItem } from '../src/api/lib/itemProjection';
import { hasFlag, readOption } from './cliArgs';
import { handleCliError, isMain, misuse, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

const STATUSES = new Set(['now', 'next', 'later', 'done', 'dropped']);

function readStatusFilter(value: string | undefined): ListItemFilters['status'] {
  if (!value) return undefined;
  const statuses = value.split(',').map((status) => status.trim()).filter(Boolean);
  for (const status of statuses) {
    if (!STATUSES.has(status)) throw new Error(`invalid status: ${status}`);
  }
  return statuses as ListItemFilters['status'];
}

export function runItemsCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const summary = hasFlag(args, '--summary');
  const fieldsArg = readOption(args, '--fields');
  try {
    const filters: ListItemFilters = {
      status: readStatusFilter(readOption(args, '--status')),
      verification: readOption(args, '--verification') as ListItemFilters['verification'],
      goal: readOption(args, '--goal'),
      type: readOption(args, '--type') as ListItemFilters['type'],
      priority: readOption(args, '--priority') as ListItemFilters['priority'],
      layer: readOption(args, '--layer'),
    };
    const items = listItems(repoRoot, filters);
    if (fieldsArg) {
      const fields = parseItemFields(fieldsArg);
      const projected = items.map((entry) => projectItem(entry, fields));
      return serialize({ ok: true, items: projected }, json, `${projected.map((entry) => `${entry.id} ${entry.status} ${entry.title}`).join('\n')}${projected.length ? '\n' : ''}`);
    }
    if (summary) {
      const projected = items.map((entry) => summarizeItem(entry));
      return serialize({ ok: true, items: projected }, json, `${projected.map((entry) => `${entry.id} ${entry.status} ${entry.title}`).join('\n')}${projected.length ? '\n' : ''}`);
    }
    return serialize({ ok: true, items }, json, `${items.map((entry) => `${entry.item.id} ${entry.item.status} ${entry.item.title}`).join('\n')}${items.length ? '\n' : ''}`);
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith('invalid field:') || err.message.startsWith('invalid status:'))) {
      return misuse(err.message, json);
    }
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
