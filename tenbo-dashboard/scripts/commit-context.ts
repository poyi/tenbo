import { resolveCommitContext } from '../src/api/lib/commitContext';
import { hasFlag, readOption } from './cliArgs';
import { isMain, misuse, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

export function runCommitContextCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const hookFormat = hasFlag(args, '--hook-format');
  const since = readOption(args, '--since');
  if (args.includes('--since') && (!since || since.startsWith('--'))) {
    return misuse('Usage: tenbo-dashboard commit-context [--since <ref>] [--json] [--hook-format]', json);
  }

  // resolveCommitContext is fail-open by design (never throws), so there is
  // no try/catch here — any internal failure already surfaces as a payload
  // with empty suggestions and a `note` explaining why.
  const payload = resolveCommitContext(repoRoot, { since });

  if (hookFormat) {
    return { stdout: payload.hook_format ? `${payload.hook_format}\n` : '', stderr: '', exitCode: 0 };
  }

  const text = payload.suggestions.length
    ? `${payload.suggestions.length} suggestion(s):\n${payload.suggestions
        .map((s) => `  ${s.id} (${s.status}) ${s.title} — ${s.reason}`)
        .join('\n')}\n\nDraft message:\n${payload.draft_message}\n`
    : `${payload.note}\n${payload.draft_message ? `\nDraft message:\n${payload.draft_message}\n` : ''}`;

  return serialize(payload, json, text);
}

if (isMain(import.meta.url)) {
  runMain(runCommitContextCli(repoRootFromCwd(), process.argv.slice(2)));
}
