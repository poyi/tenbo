import { listItems, type ListItemFilters } from '../src/api/lib/roadmapStore';
import { summarizeItem } from '../src/api/lib/itemProjection';
import { comparePriority } from '../src/api/lib/priority';
import { hasFlag, readOption } from './cliArgs';
import { handleCliError, isMain, misuse, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

const STATUSES = new Set(['now', 'next', 'later', 'done', 'dropped']);

function readStatusFilter(value: string | undefined): ListItemFilters['status'] {
  if (!value) return ['now', 'next'];
  const statuses = value.split(',').map((status) => status.trim()).filter(Boolean);
  for (const status of statuses) {
    if (!STATUSES.has(status)) throw new Error(`invalid status: ${status}`);
  }
  return statuses as ListItemFilters['status'];
}

function statusRank(status: string): number {
  return status === 'now' ? 0 : status === 'next' ? 1 : status === 'later' ? 2 : 3;
}

export function runWorkQueueCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  try {
    const filters: ListItemFilters = {
      status: readStatusFilter(readOption(args, '--status')),
      type: readOption(args, '--type') as ListItemFilters['type'],
      priority: readOption(args, '--priority') as ListItemFilters['priority'],
      layer: readOption(args, '--layer'),
      verification: readOption(args, '--verification') as ListItemFilters['verification'],
      goal: readOption(args, '--goal'),
    };
    const located = listItems(repoRoot, filters)
      .sort((a, b) => statusRank(a.item.status) - statusRank(b.item.status) || comparePriority(a.item, b.item) || a.item.id.localeCompare(b.item.id));
    const items = located.map((entry) => summarizeItem(entry));
    const payload = {
      ok: true,
      recommended_sequence: items.map((item) => item.id),
      blockers: [],
      items,
      verification: items.map((item) => ({
        id: item.id,
        commands: [
          `tenbo-dashboard item brief ${item.id} --json`,
          `tenbo-dashboard item verify ${item.id} --check --json`,
        ],
      })),
    };
    return serialize(payload, json, `${items.map((item) => `${item.id} ${item.status} ${item.title}`).join('\n')}${items.length ? '\n' : ''}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('invalid status:')) return misuse(err.message, json);
    return handleCliError(err, json);
  }
}

if (isMain(import.meta.url)) {
  runMain(runWorkQueueCli(repoRootFromCwd(), process.argv.slice(2)));
}
