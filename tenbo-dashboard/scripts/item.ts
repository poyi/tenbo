import { randomUUID } from 'node:crypto';
import { findItem, type WriteResult } from '../src/api/lib/roadmapStore';
import { summarizeItem } from '../src/api/lib/itemProjection';
import { checkItemEvidence } from '../src/api/lib/itemEvidence';
import {
  doneWhenText,
  formatCheckEvidence,
  isStructuredDoneWhen,
  runDoneWhenChecks,
  summarizeDoneWhenResults,
} from '../src/api/lib/doneWhenChecks';
import { discoverHub } from '../src/api/lib/hub/discover';
import { maybeAutostartHub } from '../src/api/lib/hub/autostart';
import { sendHubMutation } from '../src/api/lib/hub/client';
import { applyMutation, type MutationOp, type MutationRequest } from '../src/api/lib/hub/mutations';
import { resolveAgentIdentity } from '../src/api/lib/hub/identity';
import { readJournal } from '../src/api/lib/hub/journal';
import { hasFlag, positionalArgs, readOption, readRepeated } from './cliArgs';
import { handleCliError, isMain, misuse, ok, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';
import { findItemCommand, formatItemCommandHelp, formatItemHelp } from './itemCommandRegistry.mjs';

const HUB_FALLBACK_NOTICE = 'note: no tenbo hub running, writing files directly\n';

// Every value-taking flag across item subcommands, so positionalArgs can
// tell them apart from boolean flags (--json, --help, --check, --skipped)
// regardless of where a flag appears relative to the positionals (td-032).
const VALUE_FLAGS = [
  '--agent',
  '--status',
  '--evidence',
  '--note',
  '--date',
  '--reason',
  '--doc-update',
  '--commit',
  '--verification',
];

/**
 * Route one mutation through a live, repo-matched hub if `discoverHub` finds
 * one; otherwise (or on ANY hub error — network failure, timeout, hub-side
 * rejection) fail open to the exact same direct `roadmapStore` write the CLI
 * has always performed, via `applyMutation`. The hub is never allowed to
 * block a mutation from landing — see .tenbo/specs/x-004 for the design.
 *
 * `mutationId` and `agent` (td-030) are resolved ONCE here, at the CLI
 * boundary, and reused for both the hub attempt and the fallback attempt —
 * this is what makes the fallback idempotent: if the hub actually committed
 * the mutation but its HTTP response was lost, the fallback's `applyMutation`
 * call carries the SAME mutation id, sees it already journaled, and returns
 * the current state instead of double-applying.
 *
 * td-038: when discovery finds NO hub at all, this also fires
 * `maybeAutostartHub` (src/api/lib/hub/autostart.ts) as a fire-and-forget
 * side effect — it spawns a detached `hub ensure` for subsequent writes and
 * other agents, without adding any latency to THIS write. Set
 * `TENBO_NO_AUTOSTART` (any non-empty value) to disable it and keep today's
 * always-direct-write behavior.
 */
async function performMutation(repoRoot: string, op: MutationOp, agent: string): Promise<WriteResult> {
  const req: MutationRequest = { ...op, mutationId: randomUUID(), agent };
  let hub;
  try {
    hub = await discoverHub(repoRoot);
  } catch {
    hub = null;
  }
  if (hub) {
    try {
      return await sendHubMutation(hub, req);
    } catch {
      // Fall through to the direct-write fallback below.
    }
  } else {
    // td-038: no hub was discovered at all (as opposed to a hub existing but
    // this mutation attempt failing above) — lazily kick one off for
    // subsequent writes. Fire-and-forget: never awaited, never allowed to
    // throw out of this call (see autostart.ts's own fail-open guarantee).
    try {
      maybeAutostartHub(repoRoot);
    } catch {
      // Belt-and-suspenders — maybeAutostartHub already swallows its own
      // errors, but this call must never be the thing that breaks a write.
    }
  }
  process.stderr.write(HUB_FALLBACK_NOTICE);
  return applyMutation(repoRoot, req);
}

export async function runItemCli(repoRoot: string, args: string[]): Promise<CliResult> {
  const json = hasFlag(args, '--json');
  const [command, itemId, value] = positionalArgs(args, { valueFlags: VALUE_FLAGS });

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

  const agent = resolveAgentIdentity({ agentFlag: readOption(args, '--agent') });

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
      const criteria = item.done_when?.length ? item.done_when.map((entry) => `- ${doneWhenText(entry)}`).join('\n') : '- Satisfy the roadmap item description.';
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
      const result = await performMutation(repoRoot, { op: 'set-status', itemId, status: value }, agent);
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} status: ${result.item.status}\n`);
    }

    if (command === 'add-note') {
      if (!value) return misuse(`Usage: ${findItemCommand('add-note')?.usage ?? 'tenbo-dashboard item add-note <id> <note>'}`, json);
      const result = await performMutation(repoRoot, { op: 'add-note', itemId, note: value }, agent);
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} note added\n`);
    }

    if (command === 'verify') {
      if (hasFlag(args, '--check')) {
        const evidenceReport = checkItemEvidence(repoRoot, itemId);
        const located = findItem(repoRoot, itemId);
        const doneWhen = located.item.done_when ?? [];
        const structuredCount = doneWhen.filter(isStructuredDoneWhen).length;

        if (structuredCount === 0) {
          // No machine-checkable done_when entries: preserve the pre-x-003
          // evidence-heuristic behavior exactly — no execution, no mutation.
          return serialize(evidenceReport, json, `${itemId} evidence: ${evidenceReport.verdict}\n`);
        }

        // x-003: this is the ONLY path in the codebase that executes an
        // item-authored shell command, and it runs ONLY because the caller
        // passed `--check` to `item verify` explicitly. See doneWhenChecks.ts
        // for the strict-timeout mechanism and the full trust model.
        const results = await runDoneWhenChecks(repoRoot, doneWhen);
        const summary = summarizeDoneWhenResults(results);
        const status = summary.passed ? 'verified' : 'failed';
        const evidence = results.map(formatCheckEvidence);
        const passedCount = summary.checkedCount - summary.failedCount;
        const note = `item verify --check: ${passedCount}/${summary.checkedCount} structured check(s) passed, ${summary.manualCount} manual entr${summary.manualCount === 1 ? 'y' : 'ies'} not executed`;
        const mutated = await performMutation(repoRoot, { op: 'verify', itemId, status, evidence, note }, agent);

        const report = {
          ...evidenceReport,
          passed: summary.passed,
          checked_count: summary.checkedCount,
          manual_count: summary.manualCount,
          failed_count: summary.failedCount,
          results,
          verification: mutated.item.verification,
        };
        return serialize(
          report,
          json,
          `${itemId} check: ${summary.passed ? 'passed' : 'failed'} (${passedCount}/${summary.checkedCount} checks, ${summary.manualCount} manual)\n`,
        );
      }
      const status = readOption(args, '--status');
      if (!status) return misuse(`Usage: ${findItemCommand('verify')?.usage ?? 'tenbo-dashboard item verify <id> --status <status>'}`, json);
      const result = await performMutation(repoRoot, {
        op: 'verify',
        itemId,
        status,
        evidence: readRepeated(args, '--evidence'),
        note: readOption(args, '--note'),
      }, agent);
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
      const result = await performMutation(repoRoot, { op: 'doc-update', itemId, docUpdate: docUpdate ?? today }, agent);
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
      const result = await performMutation(repoRoot, {
        op: 'complete',
        itemId,
        evidence,
        ...(docUpdate ? { docUpdate } : {}),
        ...(commit ? { commit } : {}),
        ...(verificationStatus ? { verificationStatus } : {}),
      }, agent);
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} completed\n`);
    }

    if (command === 'link-commit') {
      if (!value) return misuse(`Usage: ${findItemCommand('link-commit')?.usage ?? 'tenbo-dashboard item link-commit <id> <sha>'}`, json);
      const result = await performMutation(repoRoot, { op: 'link-commit', itemId, commit: value }, agent);
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} linked commit: ${value}\n`);
    }

    if (command === 'history') {
      // Reads the append-only journal directly (see hub/journal.ts) —
      // "who changed item X and when" (td-030). No hub routing: the journal
      // lives on disk under the shared hub repo root regardless of which
      // process (hub or direct writer) appended each event, so a plain read
      // is always accurate. Validate the item exists first (like every
      // sibling command) so a typo'd id returns a structured not_found
      // error instead of masquerading as "no history yet".
      findItem(repoRoot, itemId);
      const events = readJournal(repoRoot, { itemId });
      const text = events.length === 0
        ? `${itemId}: no journal history\n`
        : `${events.map((event) => `${event.timestamp} ${event.actor} ${event.operation} (${event.mutationId})`).join('\n')}\n`;
      return serialize({ ok: true, item_id: itemId, events }, json, text);
    }

    return misuse(`unknown item command: ${command}`, json);
  } catch (err) {
    return handleCliError(err, json);
  }
}

if (isMain(import.meta.url)) {
  runMain(await runItemCli(repoRootFromCwd(), process.argv.slice(2)));
}
