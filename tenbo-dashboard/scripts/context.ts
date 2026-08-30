import { resolveFeatureContext, resolveItemContext, resolveSessionContext } from '../src/api/lib/contextResolver';
import { hasFlag, positionalArgs, readOption } from './cliArgs';
import { handleCliError, isMain, misuse, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';
import { loadCloudConfig } from '../src/cloud/cloudConfig';
import { CliTenboClient } from '../src/clients/CliTenboClient';
import type { ContextResultDto, TenboQuery } from '../src/contracts/tenbo';
import { overlayDirtyGitContext } from '../src/cloud/trustedGitDocuments';

const USAGE = 'Usage: tenbo context <feature|session|item> ... [--json]\n'
  + '  tenbo context feature --query "<request>" [--json]\n'
  + '  tenbo context session [--json]\n'
  + '  tenbo context item <id> [--document-mode summary|section|full] [--json]';

export function runContextCli(repoRoot: string, args: string[]): CliResult {
  const cloud = loadCloudConfig({ repoRoot, optional: true });
  if (cloud) return runCloudContextCli(repoRoot, args, cloud) as unknown as CliResult;
  return runLocalContextCli(repoRoot, args);
}

function runLocalContextCli(repoRoot: string, args: string[]): CliResult {
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

async function runCloudContextCli(repoRoot: string, args: string[], cloud: NonNullable<ReturnType<typeof loadCloudConfig>>): Promise<CliResult> {
  const json = hasFlag(args, '--json');
  const command = args.find((arg) => !arg.startsWith('--'));
  try {
    let query: TenboQuery;
    if (command === 'feature') {
      const text = readOption(args, '--query'); if (!text) return misuse('Usage: tenbo context feature --query "<request>" [--json]', json);
      query = { kind: 'searchContext', query: text };
    } else if (command === 'session') query = { kind: 'getSessionContext' };
    else if (command === 'item') {
      // x-117 — `--document-mode full` is the read path agents were pointed at
      // ("read the spec") while the CLI silently always sent the summary stub.
      // The flag takes a value, so it must be declared to positionalArgs or the
      // mode string would be read as the item id (the td-032 class).
      const [, itemId] = positionalArgs(args, { valueFlags: ['--document-mode'] });
      if (!itemId) return misuse('Usage: tenbo context item <id> [--document-mode summary|section|full] [--json]', json);
      const documentMode = readOption(args, '--document-mode');
      if (documentMode !== undefined && documentMode !== 'summary' && documentMode !== 'section' && documentMode !== 'full') {
        return misuse('context item: --document-mode must be summary, section, or full', json);
      }
      query = { kind: 'getItemContext', item_id: itemId, ...(documentMode ? { document_mode: documentMode } : {}) };
    } else return misuse(USAGE, json);
    const result = await new CliTenboClient(repoRoot, { cloudConfig: cloud }).query(query);
    if (result.kind !== 'context') throw new Error(`expected context, received ${result.kind}`);
    const overlaid = overlayDirtyGitContext(repoRoot, result);
    const payload = cloudContextPayload(overlaid);
    return serialize(payload, json, `${overlaid.intent} context: ${overlaid.bounds.row_count} rows, ${overlaid.bounds.token_estimate} tokens${overlaid.bounds.truncated ? ' (truncated)' : ''}\n`);
  } catch (error) { return handleCliError(error, json); }
}

function cloudContextPayload(result: ContextResultDto) {
  const payload = result.payload && typeof result.payload === 'object' && !Array.isArray(result.payload) ? result.payload : { value: result.payload };
  return { ...payload, ok: true, intent: result.intent, bounds: result.bounds };
}

if (isMain(import.meta.url)) {
  runMain(await runContextCli(repoRootFromCwd(), process.argv.slice(2)));
}
