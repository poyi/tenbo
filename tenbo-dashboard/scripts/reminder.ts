import { hasFlag } from './cliArgs';
import { isMain, misuse, runMain, serialize, type CliResult } from './cliResult';

export function renderSessionReminder(): string {
  return 'Tenbo context reminder (advisory, does not block): if this repo has .tenbo/, prefer `npx tenbo-dashboard context feature --query "<request>" --json` before broad source search.';
}

export function runReminderCli(args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const command = args.find((arg) => !arg.startsWith('--'));
  if (command !== 'print') {
    return misuse('Usage: tenbo reminder print [--json]', json);
  }
  const payload = {
    ok: true,
    mode: 'print',
    reminder: renderSessionReminder(),
  };
  return serialize(payload, json, `${payload.reminder}\n`);
}

if (isMain(import.meta.url)) {
  runMain(runReminderCli(process.argv.slice(2)));
}
