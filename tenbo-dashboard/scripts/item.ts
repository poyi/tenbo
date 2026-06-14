import {
  addItemNote,
  findItem,
  linkItemCommit,
  setItemStatus,
  setItemVerification,
} from '../src/api/lib/roadmapStore';
import { fail, handleCliError, isMain, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readOption(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

function readRepeated(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) out.push(args[i + 1]);
  }
  return out;
}

export function runItemCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const [command, itemId, value] = args.filter((arg) => arg !== '--json');
  if (!command || !itemId) return fail('invalid_args', 'Usage: tenbo item <show|set-status|add-note|verify|link-commit> <item-id>', json);

  try {
    if (command === 'show') {
      const located = findItem(repoRoot, itemId);
      return serialize({ ok: true, scope: located.scopeId, item: located.item }, json, `${itemId}: ${located.item.title} (${located.item.status})\n`);
    }

    if (command === 'set-status') {
      if (!value) return fail('invalid_args', 'Usage: tenbo item set-status <item-id> <status>', json);
      const result = setItemStatus(repoRoot, itemId, value);
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} status: ${result.item.status}\n`);
    }

    if (command === 'add-note') {
      if (!value) return fail('invalid_args', 'Usage: tenbo item add-note <item-id> <note>', json);
      const result = addItemNote(repoRoot, itemId, value);
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} note added\n`);
    }

    if (command === 'verify') {
      const status = readOption(args, '--status');
      if (!status) return fail('invalid_args', 'Usage: tenbo item verify <item-id> --status <status> [--evidence <text>] [--note <text>]', json);
      const result = setItemVerification(repoRoot, itemId, {
        status,
        evidence: readRepeated(args, '--evidence'),
        note: readOption(args, '--note'),
      });
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} verification: ${result.item.verification?.status}\n`);
    }

    if (command === 'link-commit') {
      if (!value) return fail('invalid_args', 'Usage: tenbo item link-commit <item-id> <sha>', json);
      const result = linkItemCommit(repoRoot, itemId, value);
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} linked commit: ${value}\n`);
    }

    return fail('invalid_args', `unknown item command: ${command}`, json);
  } catch (err) {
    return handleCliError(err, json);
  }
}

if (isMain(import.meta.url)) {
  runMain(runItemCli(repoRootFromCwd(), process.argv.slice(2)));
}
