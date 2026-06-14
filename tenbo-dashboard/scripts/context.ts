import { resolveFeatureContext } from '../src/api/lib/contextResolver';
import { fail, handleCliError, isMain, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readOption(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

export function runContextCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const command = args.find((arg) => !arg.startsWith('--'));

  try {
    if (command === 'feature') {
      const query = readOption(args, '--query');
      if (!query) return fail('invalid_args', 'Usage: tenbo context feature --query "<request>" [--json]', json);
      const bundle = resolveFeatureContext(repoRoot, query);
      return serialize(
        bundle,
        json,
        `${bundle.recommendation.confidence} confidence: ${bundle.recommendation.scope ?? 'unclassified'}${bundle.recommendation.layers.length ? `/${bundle.recommendation.layers.join(',')}` : ''}\n`,
      );
    }

    return fail('invalid_args', 'Usage: tenbo context feature --query "<request>" [--json]', json);
  } catch (err) {
    return handleCliError(err, json);
  }
}

if (isMain(import.meta.url)) {
  runMain(runContextCli(repoRootFromCwd(), process.argv.slice(2)));
}
