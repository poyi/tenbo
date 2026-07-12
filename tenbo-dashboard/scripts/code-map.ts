import { generateCodeMaps, isCodeMapGeneratorError } from '../src/api/lib/codeMapGenerator';
import { hasFlag, readOption } from './cliArgs';
import { fail, handleCliError, isMain, misuse, repoRootFromCwd, runMain, type CliResult } from './cliResult';

const USAGE = 'Usage: tenbo-dashboard code-map generate [--scope <id>] [--layer <id>] [--check] [--json]';

export function runCodeMapCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const command = args.find((arg) => !arg.startsWith('--'));

  if (command !== 'generate') {
    return misuse(USAGE, json);
  }

  const scope = readOption(args, '--scope');
  const layer = readOption(args, '--layer');
  const check = hasFlag(args, '--check');

  try {
    const result = generateCodeMaps(repoRoot, { scope, layer, check });
    const staleCount = result.stale_layers.length;
    const isStaleFailure = check && staleCount > 0;
    const summary = check
      ? (isStaleFailure
        ? `code-map: ${staleCount} layer(s) stale: ${result.stale_layers.join(', ')}\n`
        : `code-map: ${result.layers.length} layer(s) checked, all fresh\n`)
      : `code-map: ${result.layers.length} layer(s) generated (${staleCount} changed)\n`;

    if (json) {
      return { stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '', exitCode: isStaleFailure ? 1 : 0 };
    }
    return isStaleFailure
      ? { stdout: '', stderr: summary, exitCode: 1 }
      : { stdout: summary, stderr: '', exitCode: 0 };
  } catch (err) {
    if (isCodeMapGeneratorError(err)) {
      return fail(err.code, err.message, json);
    }
    return handleCliError(err, json);
  }
}

if (isMain(import.meta.url)) {
  runMain(runCodeMapCli(repoRootFromCwd(), process.argv.slice(2)));
}
