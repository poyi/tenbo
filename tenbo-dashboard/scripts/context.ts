import { resolveFeatureContext, resolveItemContext, resolveSessionContext } from '../src/api/lib/contextResolver';
import { hasFlag, positionalArgs, readOption } from './cliArgs';
import { handleCliError, isMain, misuse, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

const USAGE = 'Usage: tenbo context <feature|session|item> ... [--json]\n'
  + '  tenbo context feature --query "<request>" [--json]\n'
  + '  tenbo context session [--json]\n'
  + '  tenbo context item <id> [--json]';

export function runContextCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const command = args.find((arg) => !arg.startsWith('--'));

  try {
    if (command === 'feature') {
      const query = readOption(args, '--query');
      if (!query) return misuse('Usage: tenbo context feature --query "<request>" [--json]', json);
      const bundle = resolveFeatureContext(repoRoot, query);
      return serialize(
        bundle,
        json,
        `${bundle.recommendation.confidence} confidence: ${bundle.recommendation.scope ?? 'unclassified'}${bundle.recommendation.layers.length ? `/${bundle.recommendation.layers.join(',')}` : ''}\n`,
      );
    }

    if (command === 'session') {
      const bundle = resolveSessionContext(repoRoot);
      return serialize(
        bundle,
        json,
        `now: ${bundle.now.count} (${bundle.stale.now.length} stale), stale next: ${bundle.stale.next.length}\n`,
      );
    }

    if (command === 'item') {
      // `item` itself has no value-taking flags (only boolean --json), so
      // any --flag encountered here never consumes the following token —
      // this keeps `context item --json <id>` and `context item <id>
      // --json` equivalent (td-032).
      const [, itemId] = positionalArgs(args);
      if (!itemId) return misuse('Usage: tenbo context item <id> [--json]', json);
      const bundle = resolveItemContext(repoRoot, itemId);
      return serialize(
        bundle,
        json,
        `${bundle.item_id}: ${bundle.item.title} (${bundle.item.status})\n`,
      );
    }

    return misuse(USAGE, json);
  } catch (err) {
    return handleCliError(err, json);
  }
}

if (isMain(import.meta.url)) {
  runMain(runContextCli(repoRootFromCwd(), process.argv.slice(2)));
}
