import {
  addItemNote,
  completeItem,
  findItem,
  linkItemCommit,
  setItemDocUpdate,
  setItemStatus,
  setItemVerification,
} from '../src/api/lib/roadmapStore';
import { summarizeItem } from '../src/api/lib/itemProjection';
import { checkItemEvidence } from '../src/api/lib/itemEvidence';
import { hasFlag, positionalArgs, readOption, readRepeated } from './cliArgs';
import { handleCliError, isMain, misuse, ok, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';
import { findItemCommand, formatItemCommandHelp, formatItemHelp } from './itemCommandRegistry.mjs';

export function runItemCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const [command, itemId, value] = positionalArgs(args);

  if (hasFlag(args, '--help') || command === 'help') {
    const helpCommand = command === 'help' ? itemId : command;
    if (helpCommand) {
      const help = formatItemCommandHelp(helpCommand);
      if (help) return ok(help);
      return misuse(`unknown item command: ${helpCommand}`, json);
    }
    return ok(formatItemHelp());
  }

  if (!command) return misuse(formatItemHelp().trimEnd(), json);
  if (!itemId) {
    const definition = findItemCommand(command);
    return misuse(definition ? `Usage: ${definition.usage}` : `unknown item command: ${command}`, json);
  }

  try {
    if (command === 'show') {
      const located = findItem(repoRoot, itemId);
      return serialize({ ok: true, scope: located.scopeId, item: located.item }, json, `${itemId}: ${located.item.title} (${located.item.status})\n`);
    }

    if (command === 'brief') {
      const located = findItem(repoRoot, itemId);
      const item = located.item;
      return serialize({
        ok: true,
        scope: located.scopeId,
        item: summarizeItem(located),
        files_to_read: item.files_to_read ?? [],
        acceptance_criteria: item.done_when ?? [],
        risks: item.risks ?? [],
        verification_commands: [
          `tenbo-dashboard item verify ${item.id} --check --json`,
        ],
        completion_commands: [
          `tenbo-dashboard item complete ${item.id} --evidence "<evidence>" --doc-update today --json`,
        ],
      }, json, `${item.id}: ${item.title} (${item.status})\n`);
    }

    if (command === 'handoff') {
      const located = findItem(repoRoot, itemId);
      const item = located.item;
      const files = item.files_to_read?.length ? item.files_to_read.map((file) => `- ${file}`).join('\n') : '- Read the linked item/spec first.';
      const criteria = item.done_when?.length ? item.done_when.map((entry) => `- ${entry}`).join('\n') : '- Satisfy the roadmap item description.';
      const risks = item.risks?.length ? item.risks.map((entry) => `- ${entry}`).join('\n') : '- No known overlap risks recorded.';
      const prompt = [
        `Implement ${item.id}: ${item.title}`,
        '',
        'Files to read',
        files,
        '',
        'Non-goals',
        '- Do not broaden scope beyond this roadmap item.',
        '- Do not edit unrelated roadmap items or user changes.',
        '',
        'Overlap risks',
        risks,
        '',
        'Acceptance criteria',
        criteria,
        '',
        'Verification commands',
        `- tenbo-dashboard item verify ${item.id} --check --json`,
        '- Run focused tests for touched code.',
        '',
        'Completion rules',
        `- Use tenbo-dashboard item complete ${item.id} --evidence "<evidence>" --doc-update today --json when the item is actually complete.`,
        '- Report tests run and any residual risks.',
      ].join('\n');
      return serialize({ ok: true, item_id: item.id, scope: located.scopeId, prompt }, json, `${prompt}\n`);
    }

    if (command === 'set-status') {
      if (!value) return misuse(`Usage: ${findItemCommand('set-status')?.usage ?? 'tenbo-dashboard item set-status <id> <status>'}`, json);
      const result = setItemStatus(repoRoot, itemId, value);
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} status: ${result.item.status}\n`);
    }

    if (command === 'add-note') {
      if (!value) return misuse(`Usage: ${findItemCommand('add-note')?.usage ?? 'tenbo-dashboard item add-note <id> <note>'}`, json);
      const result = addItemNote(repoRoot, itemId, value);
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} note added\n`);
    }

    if (command === 'verify') {
      if (hasFlag(args, '--check')) {
        const report = checkItemEvidence(repoRoot, itemId);
        return serialize(report, json, `${itemId} evidence: ${report.verdict}\n`);
      }
      const status = readOption(args, '--status');
      if (!status) return misuse(`Usage: ${findItemCommand('verify')?.usage ?? 'tenbo-dashboard item verify <id> --status <status>'}`, json);
      const result = setItemVerification(repoRoot, itemId, {
        status,
        evidence: readRepeated(args, '--evidence'),
        note: readOption(args, '--note'),
      });
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} verification: ${result.item.verification?.status}\n`);
    }

    if (command === 'doc-update') {
      const date = readOption(args, '--date');
      const skipped = hasFlag(args, '--skipped');
      const reason = readOption(args, '--reason');
      if (!date && !skipped) return misuse(`Usage: ${findItemCommand('doc-update')?.usage ?? 'tenbo-dashboard item doc-update <id> --date <today|YYYY-MM-DD>'}`, json);
      if (skipped && !reason) return misuse('Usage: tenbo-dashboard item doc-update <id> --skipped --reason "<text>"', json);
      const today = new Date().toISOString().slice(0, 10);
      const docUpdate = skipped ? `skipped — ${reason}` : date === 'today' ? today : date;
      const result = setItemDocUpdate(repoRoot, itemId, docUpdate ?? today);
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} doc_update: ${result.item.doc_update}\n`);
    }

    if (command === 'complete') {
      const evidence = readRepeated(args, '--evidence');
      const docUpdateArg = readOption(args, '--doc-update');
      const commit = readOption(args, '--commit');
      const verificationStatus = readOption(args, '--verification');
      if (evidence.length === 0) return misuse(`Usage: ${findItemCommand('complete')?.usage ?? 'tenbo-dashboard item complete <id> --evidence "<text>"'}`, json);
      const today = new Date().toISOString().slice(0, 10);
      const docUpdate = docUpdateArg === 'today' ? today : docUpdateArg;
      const result = completeItem(repoRoot, itemId, {
        evidence,
        ...(docUpdate ? { docUpdate } : {}),
        ...(commit ? { commit } : {}),
        ...(verificationStatus ? { verificationStatus } : {}),
      });
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} completed\n`);
    }

    if (command === 'link-commit') {
      if (!value) return misuse(`Usage: ${findItemCommand('link-commit')?.usage ?? 'tenbo-dashboard item link-commit <id> <sha>'}`, json);
      const result = linkItemCommit(repoRoot, itemId, value);
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} linked commit: ${value}\n`);
    }

    return misuse(`unknown item command: ${command}`, json);
  } catch (err) {
    return handleCliError(err, json);
  }
}

if (isMain(import.meta.url)) {
  runMain(runItemCli(repoRootFromCwd(), process.argv.slice(2)));
}
