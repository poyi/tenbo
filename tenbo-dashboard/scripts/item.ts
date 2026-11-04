import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertValidStatusForCli, findItem, type WriteResult } from '../src/api/lib/roadmapStore';
import { summarizeItem } from '../src/api/lib/itemProjection';
import { checkItemEvidence, checkItemEvidenceForItem } from '../src/api/lib/itemEvidence';
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
import { CliTenboClient } from '../src/clients/CliTenboClient';
import type { ItemCreateDto, ItemRichPatchDto, PlanningDocumentKind, TenboCommandResult } from '../src/contracts/tenbo';

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
  '--scope',
  '--title',
  '--description',
  '--layer',
  '--type',
  '--priority',
  '--goal',
  '--patch',
  '--ids',
  '--owner',
  '--lease',
  '--fencing-token',
  '--kind',
  '--slug',
  '--content',
  '--content-file',
  '--expected-version',
  '--heading',
  '--section-hash',
  '--from-version',
  '--to-version',
  '--version',
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

async function performTypedCommand(client: CliTenboClient, command: Parameters<CliTenboClient['command']>[0], agent: string): Promise<TenboCommandResult> {
  return client.command(command, { id: agent, type: 'agent' });
}

async function performCompatibleMutation(
  client: CliTenboClient,
  repoRoot: string,
  op: MutationOp,
  agent: string,
  expectedVersion?: string,
): Promise<WriteResult> {
  if (!client.isCloud) return performMutation(repoRoot, op, agent);
  const command = op.op === 'set-status' ? { kind: 'setStatus' as const, item_id: op.itemId, status: assertValidStatusForCli(op.status) }
    : op.op === 'add-note' ? { kind: 'addNote' as const, item_id: op.itemId, note: op.note }
    : op.op === 'verify' ? { kind: 'setVerification' as const, item_id: op.itemId, status: op.status as any, evidence: op.evidence, note: op.note }
    : op.op === 'doc-update' ? { kind: 'setDocUpdate' as const, item_id: op.itemId, doc_update: op.docUpdate }
    : op.op === 'link-commit' ? { kind: 'linkCommit' as const, item_id: op.itemId, commit: op.commit }
    : { kind: 'completeItem' as const, item_id: op.itemId, evidence: op.evidence,
        ...(op.docUpdate ? { doc_update: op.docUpdate } : {}), ...(op.commit ? { commit: op.commit } : {}),
        ...(op.verificationStatus ? { verification_status: op.verificationStatus as any } : {}) };
  const result = typedItemResult(await performTypedCommand(client, { ...command, ...(expectedVersion !== undefined ? { expected_version: expectedVersion } : {}) }, agent));
  return { scopeId: result.value.scope_id, filePath: '', item: result.value.item, validation: result.validation ?? { errors: [], warnings: [] } };
}

async function findItemThroughClient(client: CliTenboClient, repoRoot: string, itemId: string) {
  if (!client.isCloud) return findItem(repoRoot, itemId);
  const result = await client.query({ kind: 'getItem', item_id: itemId, include_archived: true });
  if (result.kind !== 'item') throw new Error(`expected item result, received ${result.kind}`);
  return {
    scopeId: result.value.scope_id,
    filePath: '',
    item: result.value.item,
    archived: result.value.archived,
    dependsOn: result.value.depends_on ?? [],
    unresolvedBlockers: result.value.unresolved_blockers ?? [],
    readiness: result.value.readiness ?? 'ready',
    specification: result.value.specification,
  };
}

function typedItemResult(result: TenboCommandResult) {
  if (result.kind !== 'item') throw new Error(`expected item command result, received ${result.kind}`);
  return result;
}

function planningKind(value: string | undefined): PlanningDocumentKind {
  if (value === 'spec' || value === 'workpad' || value === 'handoff') return value;
  throw new Error('--kind must be spec, workpad, or handoff');
}

function documentContent(repoRoot: string, args: string[]): string {
  const inline = readOption(args, '--content');
  const file = readOption(args, '--content-file');
  if (inline !== undefined && file !== undefined) throw new Error('use only one of --content or --content-file');
  if (file) return readFileSync(path.resolve(repoRoot, file), 'utf8');
  if (inline !== undefined) return inline;
  throw new Error('--content or --content-file is required');
}

function requiredPositiveOption(args: string[], name: string): number {
  const raw = readOption(args, name);
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function requiredOption(args: string[], name: string): string {
  const value = readOption(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
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
    const client = new CliTenboClient(repoRoot);
    const compatibilityMutation = ['set-status', 'add-note', 'verify', 'doc-update', 'complete', 'link-commit'].includes(command);
    let expectedVersion: string | undefined;
    if (compatibilityMutation) {
      for (const flag of ['--fencing-token', '--owner']) {
        if (args.some(arg => arg === flag || arg.startsWith(`${flag}=`))) {
          return misuse(`${flag} is not supported by item ${command}`, json);
        }
      }
      if (args.some(arg => arg.startsWith('--expected-version='))) return misuse('use --expected-version <version>', json);
      if (hasFlag(args, '--expected-version')) {
        expectedVersion = requiredOption(args, '--expected-version');
        if (!expectedVersion.trim() || expectedVersion.startsWith('--')) return misuse('--expected-version requires a value', json);
        if (!client.isCloud) return misuse('--expected-version is not supported by the local compatibility mutation path', json);
      }
    }

    if (command === 'allocate-id') {
      const result = await performTypedCommand(client, { kind: 'allocateItemId', prefix: itemId }, agent);
      if (result.kind !== 'allocation') throw new Error(`expected allocation result, received ${result.kind}`);
      return serialize({ ok: true, item_id: result.item_id }, json, `${result.item_id}\n`);
    }

    if (command === 'create') {
      const scopeId = readOption(args, '--scope');
      const title = readOption(args, '--title');
      const description = readOption(args, '--description');
      if (!scopeId || !title || !description) return misuse('Usage: tenbo-dashboard item create <id> --scope <scope> --title "<title>" --description "<description>" [options]', json);
      const status = assertValidStatusForCli(readOption(args, '--status') ?? 'later');
      const type = readOption(args, '--type') as ItemCreateDto['type'];
      const priority = readOption(args, '--priority') as ItemCreateDto['priority'];
      const goals = readRepeated(args, '--goal');
      const item: ItemCreateDto = {
        id: itemId,
        title,
        description,
        status,
        ...(readOption(args, '--layer') ? { layer: readOption(args, '--layer') } : {}),
        ...(type ? { type } : {}),
        ...(priority ? { priority } : {}),
        ...(goals.length > 0 ? { goal_ref: goals } : {}),
      };
      const result = typedItemResult(await performTypedCommand(client, { kind: 'createItem', scope_id: scopeId, item }, agent));
      return serialize({ ok: true, scope: result.value.scope_id, item: result.value.item, version: result.value.version, validation: result.validation }, json, `${itemId} created\n`);
    }

    if (command === 'update') {
      const raw = readOption(args, '--patch');
      if (!raw) return misuse('Usage: tenbo-dashboard item update <id> --patch \'{"title":"New title"}\'', json);
      const patch = JSON.parse(raw) as ItemRichPatchDto;
      const result = typedItemResult(await performTypedCommand(client, {
        kind: 'updateRichFields',
        item_id: itemId,
        patch,
        ...(readOption(args, '--expected-version') ? { expected_version: readOption(args, '--expected-version') } : {}),
      }, agent));
      return serialize({ ok: true, scope: result.value.scope_id, item: result.value.item, version: result.value.version, validation: result.validation }, json, `${itemId} updated\n`);
    }

    if (command === 'reorder') {
      const ids = (readOption(args, '--ids') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
      if (ids.length === 0) return misuse('Usage: tenbo-dashboard item reorder <scope> --ids <id1,id2,...>', json);
      const result = await performTypedCommand(client, {
        kind: 'reorderItems',
        scope_id: itemId,
        item_ids: ids,
        ...(readOption(args, '--expected-version') ? { expected_list_version: readOption(args, '--expected-version') } : {}),
      }, agent);
      if (result.kind !== 'reorder') throw new Error(`expected reorder result, received ${result.kind}`);
      return serialize({ ok: true, ...result }, json, `${itemId} reordered\n`);
    }

    if (command === 'archive') {
      const result = typedItemResult(await performTypedCommand(client, {
        kind: 'archiveItem', item_id: itemId,
        ...(readOption(args, '--expected-version') ? { expected_version: readOption(args, '--expected-version') } : {}),
      }, agent));
      return serialize({ ok: true, item: result.value.item, archived: result.value.archived, validation: result.validation }, json, `${itemId} archived\n`);
    }

    if (command === 'reopen') {
      const requested = readOption(args, '--status') ?? 'next';
      const status = assertValidStatusForCli(requested);
      if (status === 'done' || status === 'dropped') return misuse('reopen status must be now, next, or later', json);
      const result = typedItemResult(await performTypedCommand(client, {
        kind: 'reopenItem', item_id: itemId, status,
        ...(readOption(args, '--expected-version') ? { expected_version: readOption(args, '--expected-version') } : {}),
      }, agent));
      return serialize({ ok: true, item: result.value.item, version: result.value.version, validation: result.validation }, json, `${itemId} reopened\n`);
    }

    if (command === 'claim') {
      const owner = readOption(args, '--owner') ?? agent;
      const lease = readOption(args, '--lease');
      const result = await performTypedCommand(client, {
        kind: 'claimItem', item_id: itemId, owner,
        ...(lease ? { lease_seconds: Number(lease) } : {}),
      }, agent);
      if (result.kind !== 'claim') throw new Error(`expected claim result, received ${result.kind}`);
      return serialize({ ok: true, claim: result.value }, json, `${itemId} claimed by ${owner} until ${result.value.expires_at}\n`);
    }

    if (command === 'renew-claim' || command === 'release-claim') {
      const owner = readOption(args, '--owner') ?? agent;
      const fencing = Number(readOption(args, '--fencing-token'));
      if (!Number.isInteger(fencing) || fencing <= 0) return misuse(`Usage: tenbo-dashboard item ${command} <id> --fencing-token <n> [--owner <actor>]`, json);
      const lease = readOption(args, '--lease');
      const result = await performTypedCommand(client, command === 'renew-claim'
        ? { kind: 'renewClaim', item_id: itemId, owner, fencing_token: fencing, ...(lease ? { lease_seconds: Number(lease) } : {}) }
        : { kind: 'releaseClaim', item_id: itemId, owner, fencing_token: fencing }, agent);
      return serialize({ ok: true, result }, json, `${itemId} claim ${command === 'renew-claim' ? 'renewed' : 'released'}\n`);
    }

    if (command === 'dependency-add' || command === 'dependency-remove') {
      if (!value) return misuse(`Usage: tenbo-dashboard item ${command} <id> <prerequisite-id> [--expected-version <version>] [--fencing-token <n>]`, json);
      const rawFence = readOption(args, '--fencing-token');
      const fence = rawFence === undefined ? undefined : Number(rawFence);
      if (fence !== undefined && (!Number.isInteger(fence) || fence <= 0)) {
        return misuse('--fencing-token must be a positive integer', json);
      }
      const result = typedItemResult(await performTypedCommand(client, {
        kind: command === 'dependency-add' ? 'addDependency' : 'removeDependency',
        item_id: itemId,
        prerequisite_id: value,
        ...(readOption(args, '--expected-version') ? { expected_version: readOption(args, '--expected-version') } : {}),
        ...(fence !== undefined ? { fencing_token: fence } : {}),
      }, agent));
      return serialize({
        ok: true,
        item: result.value.item,
        version: result.value.version,
        depends_on: result.value.depends_on ?? [],
        unresolved_blockers: result.value.unresolved_blockers ?? [],
        readiness: result.value.readiness ?? 'ready',
      }, json, `${itemId} dependency ${command === 'dependency-add' ? 'added' : 'removed'}: ${value}\n`);
    }

    if (command === 'document-create') {
      const kind = planningKind(readOption(args, '--kind'));
      const result = await performTypedCommand(client, {
        kind: 'createPlanningDocument', item_id: itemId, document_kind: kind,
        ...(readOption(args, '--slug') ? { slug: readOption(args, '--slug') } : {}),
        content: documentContent(repoRoot, args),
        fencing_token: requiredPositiveOption(args, '--fencing-token'),
      }, agent);
      if (result.kind !== 'document') throw new Error(`expected document result, received ${result.kind}`);
      return serialize({ ok: true, document: result.value }, json, `${result.value.path} created\n`);
    }

    if (command === 'document-update') {
      const result = await performTypedCommand(client, {
        kind: 'updatePlanningDocument', document_id: itemId, content: documentContent(repoRoot, args),
        expected_version: requiredOption(args, '--expected-version'),
        fencing_token: requiredPositiveOption(args, '--fencing-token'),
      }, agent);
      if (result.kind !== 'document') throw new Error(`expected document result, received ${result.kind}`);
      return serialize({ ok: true, document: result.value }, json, `${result.value.path} updated\n`);
    }

    if (command === 'document-section-replace' || command === 'document-section-append') {
      const replacing = command === 'document-section-replace';
      const result = await performTypedCommand(client, replacing ? {
        kind: 'replacePlanningDocumentSection',
        document_id: itemId,
        heading: requiredOption(args, '--heading'),
        content: documentContent(repoRoot, args),
        expected_section_hash: requiredOption(args, '--section-hash'),
        expected_version: requiredOption(args, '--expected-version'),
        fencing_token: requiredPositiveOption(args, '--fencing-token'),
      } : {
        kind: 'appendPlanningDocumentSection',
        document_id: itemId,
        heading: requiredOption(args, '--heading'),
        content: documentContent(repoRoot, args),
        expected_version: requiredOption(args, '--expected-version'),
        fencing_token: requiredPositiveOption(args, '--fencing-token'),
      }, agent);
      if (result.kind !== 'document') throw new Error(`expected document result, received ${result.kind}`);
      return serialize({ ok: true, document: result.value }, json, `${result.value.path} section updated\n`);
    }

    if (command === 'document-show') {
      // x-117 — the read half of the document commands. Agents told to "read
      // the spec" only ever had the ~300-char context stub; getDocument was
      // wired end-to-end but never exposed.
      const result = await client.query({ kind: 'getDocument', document_id: itemId });
      if (result.kind !== 'document') throw new Error(`expected document, received ${result.kind}`);
      return serialize({ ok: true, document: result.value }, json, `${itemId} fetched\n`);
    }

    if (command === 'document-versions') {
      const result = await client.query({ kind: 'getDocumentVersions', document_id: itemId });
      if (result.kind !== 'documentVersionPage') throw new Error(`expected documentVersionPage, received ${result.kind}`);
      return serialize({ ok: true, versions: result.value, page: result.page }, json, `${result.value.length} version(s)\n`);
    }

    if (command === 'document-diff') {
      const result = await client.query({
        kind: 'compareDocumentVersions',
        document_id: itemId,
        from_version: requiredOption(args, '--from-version'),
        to_version: requiredOption(args, '--to-version'),
      });
      if (result.kind !== 'documentDiff') throw new Error(`expected documentDiff, received ${result.kind}`);
      return serialize({ ok: true, diff: result.value }, json, 'document versions compared\n');
    }

    if (command === 'document-version-restore') {
      const result = await performTypedCommand(client, {
        kind: 'restorePlanningDocumentVersion',
        document_id: itemId,
        version: requiredOption(args, '--version'),
        expected_version: requiredOption(args, '--expected-version'),
        fencing_token: requiredPositiveOption(args, '--fencing-token'),
      }, agent);
      if (result.kind !== 'document') throw new Error(`expected document result, received ${result.kind}`);
      return serialize({ ok: true, document: result.value }, json, `${result.value.path} version restored\n`);
    }

    if (command === 'document-archive' || command === 'document-restore') {
      const result = await performTypedCommand(client, {
        kind: command === 'document-archive' ? 'archivePlanningDocument' : 'restorePlanningDocument',
        document_id: itemId,
        expected_version: requiredOption(args, '--expected-version'),
        fencing_token: requiredPositiveOption(args, '--fencing-token'),
      }, agent);
      if (result.kind !== 'document') throw new Error(`expected document result, received ${result.kind}`);
      return serialize({ ok: true, document: result.value }, json, `${result.value.path} ${command === 'document-archive' ? 'archived' : 'restored'}\n`);
    }

    if (command === 'show') {
      const located = await findItemThroughClient(client, repoRoot, itemId);
      return serialize({
        ok: true,
        scope: located.scopeId,
        item: located.item,
        depends_on: 'dependsOn' in located ? located.dependsOn : located.item.depends_on ?? [],
        unresolved_blockers: 'unresolvedBlockers' in located ? located.unresolvedBlockers : [],
        readiness: 'readiness' in located ? located.readiness : 'ready',
        ...('specification' in located && located.specification ? { specification: located.specification } : {}),
      }, json, `${itemId}: ${located.item.title} (${located.item.status})\n`);
    }

    if (command === 'brief') {
      const located = await findItemThroughClient(client, repoRoot, itemId);
      const item = located.item;
      return serialize({
        ok: true,
        scope: located.scopeId,
        item: summarizeItem(located),
        depends_on: 'dependsOn' in located ? located.dependsOn : item.depends_on ?? [],
        unresolved_blockers: 'unresolvedBlockers' in located ? located.unresolvedBlockers : [],
        readiness: 'readiness' in located ? located.readiness : 'ready',
        ...('specification' in located && located.specification ? { specification: located.specification } : {}),
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
      const located = await findItemThroughClient(client, repoRoot, itemId);
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
      const result = await performCompatibleMutation(client, repoRoot, { op: 'set-status', itemId, status: value }, agent, expectedVersion);
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} status: ${result.item.status}\n`);
    }

    if (command === 'add-note') {
      if (!value) return misuse(`Usage: ${findItemCommand('add-note')?.usage ?? 'tenbo-dashboard item add-note <id> <note>'}`, json);
      const result = await performCompatibleMutation(client, repoRoot, { op: 'add-note', itemId, note: value }, agent, expectedVersion);
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} note added\n`);
    }

    if (command === 'verify') {
      if (hasFlag(args, '--check')) {
        const located = await findItemThroughClient(client, repoRoot, itemId);
        const evidenceReport = client.isCloud ? checkItemEvidenceForItem(located.item) : checkItemEvidence(repoRoot, itemId);
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
        const mutated = await performCompatibleMutation(client, repoRoot, { op: 'verify', itemId, status, evidence, note }, agent, expectedVersion);

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
      const result = await performCompatibleMutation(client, repoRoot, {
        op: 'verify',
        itemId,
        status,
        evidence: readRepeated(args, '--evidence'),
        note: readOption(args, '--note'),
      }, agent, expectedVersion);
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
      const result = await performCompatibleMutation(client, repoRoot, { op: 'doc-update', itemId, docUpdate: docUpdate ?? today }, agent, expectedVersion);
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
      const result = await performCompatibleMutation(client, repoRoot, {
        op: 'complete',
        itemId,
        evidence,
        ...(docUpdate ? { docUpdate } : {}),
        ...(commit ? { commit } : {}),
        ...(verificationStatus ? { verificationStatus } : {}),
      }, agent, expectedVersion);
      return serialize({ ok: true, scope: result.scopeId, item: result.item, validation: result.validation }, json, `${itemId} completed\n`);
    }

    if (command === 'link-commit') {
      if (!value) return misuse(`Usage: ${findItemCommand('link-commit')?.usage ?? 'tenbo-dashboard item link-commit <id> <sha>'}`, json);
      const result = await performCompatibleMutation(client, repoRoot, { op: 'link-commit', itemId, commit: value }, agent, expectedVersion);
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
      const events = client.isCloud
        ? await (async () => {
            const result = await client.query({ kind: 'getMutationHistory', item_id: itemId, page: { limit: 100 } });
            if (result.kind !== 'mutationHistory') throw new Error(`expected mutationHistory, received ${result.kind}`);
            return result.value.map((event) => ({ mutationId: event.mutation_id, actor: event.actor, timestamp: event.timestamp, itemId: event.item_id, operation: event.operation }));
          })()
        : (findItem(repoRoot, itemId), readJournal(repoRoot, { itemId }));
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
