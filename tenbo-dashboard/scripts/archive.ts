/**
 * archive.ts — CLI to move done/dropped roadmap items to roadmap-archive.yaml.
 *
 * Usage:
 *   npx tenbo-dashboard archive [--scope <id>] [--days 30] [--max 20]
 *
 * --days  (default 30): only archive done/dropped items whose doc_update is older than N days.
 * --max   (default 20): only trigger if done+dropped count exceeds this threshold per scope.
 * --scope: limit to one scope (default: all scopes).
 */
import { findRepoRoot } from '../src/api/lib/repoRoot';
import { readState, archiveItems } from '../src/api/lib/tenboFs';
import type { Item } from '../src/types';
import path from 'node:path';

function parseArgs(argv: string[]): { scope?: string; days: number; max: number } {
  let scope: string | undefined;
  let days = 30;
  let max = 20;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scope' && argv[i + 1]) {
      scope = argv[++i];
    } else if (argv[i] === '--days' && argv[i + 1]) {
      days = parseInt(argv[++i], 10);
    } else if (argv[i] === '--max' && argv[i + 1]) {
      max = parseInt(argv[++i], 10);
    }
  }
  return { scope, days, max };
}

function isOlderThanDays(docUpdate: string | undefined, days: number): boolean {
  if (!docUpdate) return false;
  const match = docUpdate.match(/^\d{4}-\d{2}-\d{2}$/);
  if (!match) return false;
  const itemDate = new Date(docUpdate);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return itemDate <= cutoff;
}

function getArchivableIds(items: Item[], days: number, maxThreshold: number): string[] {
  const doneDropped = items.filter(i => i.status === 'done' || i.status === 'dropped');
  if (doneDropped.length <= maxThreshold) return [];
  return doneDropped
    .filter(i => isOlderThanDays(i.doc_update, days))
    .map(i => i.id);
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
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const repoRoot = findRepoRoot(cwd) ?? path.resolve(cwd, '..', '..');

  const state = readState(repoRoot);
  const scopesToProcess = args.scope
    ? state.scopes.filter(s => s.id === args.scope)
    : state.scopes;

  if (args.scope && scopesToProcess.length === 0) {
    process.stderr.write(`Error: scope '${args.scope}' not found.\n`);
    process.exit(1);
  }

  let totalArchived = 0;
  for (const scope of scopesToProcess) {
    const ids = getArchivableIds(scope.items, args.days, args.max);
    if (ids.length > 0) {
      archiveItems(repoRoot, scope.id, ids);
      console.log(`Archived ${ids.length} items from scope '${scope.id}' to roadmap-archive.yaml`);
      totalArchived += ids.length;
    }
  }

  if (totalArchived === 0) {
    console.log('No items eligible for archiving.');
  }
}
