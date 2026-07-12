import {
  applyReconciliationFlag,
  clearPendingReconciliation,
  planReconciliationFlag,
  type ReconciliationFlagPlan,
  type ReconciliationFlagResult,
  type ClearReconciliationResult,
} from '../src/api/lib/reconciliationFlag';
import { hasFlag, readOption } from './cliArgs';
import { handleCliError, isMain, misuse, ok, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

function formatPlan(plan: ReconciliationFlagPlan, dryRun: boolean): string {
  const lines = [plan.note];
  for (const entry of plan.entries) {
    lines.push(`  [${entry.action}] ${entry.layer} (${entry.source_commit.slice(0, 12)}) — ${entry.description}`);
  }
  if (dryRun) lines.push('(dry-run — no changes written)');
  return `${lines.join('\n')}\n`;
}

function formatApply(result: ReconciliationFlagResult): string {
  const lines = [result.note];
  for (const entry of result.entries) {
    lines.push(`  ${entry.layer} (${entry.source_commit.slice(0, 12)}) — ${entry.description}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatClear(result: ClearReconciliationResult): string {
  const lines = [result.note];
  for (const entry of result.removed) {
    lines.push(`  removed: ${entry.layer} (${entry.source_commit.slice(0, 12)}) [${entry.kind}]`);
  }
  return `${lines.join('\n')}\n`;
}

const HELP_TEXT = `tenbo-dashboard reconcile — pending-reconciliation doc-flag ledger (td-028)

Usage:
  tenbo-dashboard reconcile flag [--since <ref>] [--dry-run] [--json]
  tenbo-dashboard reconcile clear --layer <scope:layer> | --commit <sha> [--json]

flag: maps a commit's diff (default: HEAD~1..HEAD) to affected layers via
\`impact\` and appends one pending-reconciliation entry per affected layer to
.tenbo/.pending-reconciliation.yaml. Deterministic, no LLM. Duplicate
(layer, source_commit) pairs are skipped; a layer's prior open doc-flag
entry is refreshed in place instead of piling up. This is what the opt-in
post-commit hook calls (\`hook install post-commit\`).

clear: removes matching entries once the doc update for a flagged layer is
done. Requires at least one of --layer / --commit.
`;

export function runReconcileCli(repoRoot: string, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const action = args[0];

  if (!action || action === 'help' || action === '--help') {
    return ok(HELP_TEXT);
  }

  if (action === 'flag') {
    const since = readOption(args, '--since');
    if (args.includes('--since') && (!since || since.startsWith('--'))) {
      return misuse('Usage: tenbo-dashboard reconcile flag [--since <ref>] [--dry-run] [--json]', json);
    }
    const dryRun = hasFlag(args, '--dry-run');
    try {
      const plan = planReconciliationFlag(repoRoot, { since });
      if (dryRun) {
        return serialize({ ...plan, dry_run: true }, json, formatPlan(plan, true));
      }
      const result = applyReconciliationFlag(repoRoot, plan);
      return serialize(result, json, formatApply(result));
    } catch (err) {
      return handleCliError(err, json);
    }
  }

  if (action === 'clear') {
    const layer = readOption(args, '--layer');
    const commit = readOption(args, '--commit');
    if (!layer && !commit) {
      return misuse('Usage: tenbo-dashboard reconcile clear --layer <scope:layer> | --commit <sha> [--json]', json);
    }
    try {
      const result = clearPendingReconciliation(repoRoot, { layer, commit });
      return serialize(result, json, formatClear(result));
    } catch (err) {
      return handleCliError(err, json);
    }
  }

  return misuse(`reconcile: unknown action '${action}'. Expected 'flag' or 'clear'.`, json);
}

if (isMain(import.meta.url)) {
  runMain(runReconcileCli(repoRootFromCwd(), process.argv.slice(2)));
}
