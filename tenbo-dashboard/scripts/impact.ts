import { resolveImpact } from '../src/api/lib/impact';
import { hasFlag, readOption } from './cliArgs';
import { handleCliError, isMain, misuse, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

export function runImpactCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const since = readOption(args, '--since');
  if (args.includes('--since') && (!since || since.startsWith('--'))) {
    return misuse('Usage: tenbo impact [--since <ref>] [--json]', json);
  }
  try {
    const payload = resolveImpact(repoRoot, { since });
    return serialize(
      payload,
      json,
      `${payload.changed_files.length} changed file(s), ${payload.affected_layers.length} affected layer(s)\n`,
    );
  } catch (err) {
    return handleCliError(err, json);
  }
}

if (isMain(import.meta.url)) {
  runMain(runImpactCli(repoRootFromCwd(), process.argv.slice(2)));
}
