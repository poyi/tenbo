/**
 * reconciliationFlag.ts — post-commit doc-flag detection (td-028).
 *
 * Maps the diff of a just-made commit to affected layers (reusing
 * `resolveImpact`, no re-derivation here) and appends one pending-
 * reconciliation entry per affected layer to
 * `.tenbo/.pending-reconciliation.yaml` — the same ledger the sk-035
 * reconciliation behavior and `resolveSessionContext`'s session briefing
 * already read (see `skill/references/reconciliation.md` for the schema).
 *
 * Deterministic, fail-open, flag-only:
 *   - Never invokes an LLM.
 *   - Never edits docs, code-map.md, or roadmap items — the only file this
 *     module writes is `.tenbo/.pending-reconciliation.yaml`.
 *   - `planReconciliationFlag` never throws: any git/impact failure (not a
 *     repo, root commit with no HEAD~1, missing `.tenbo/`, etc.) resolves to
 *     `ok: true` with zero entries and a human-readable `note`.
 *   - Plan/apply are split (mirrors `hook.ts`'s install plan/apply split) so
 *     `--dry-run` can report exactly what would change without writing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYamlText, stringify as stringifyYamlText } from 'yaml';
import { resolveImpact } from './impact';

export const DOC_FLAG_KIND = 'doc-flag';
const PENDING_RECONCILIATION_REL_PATH = '.tenbo/.pending-reconciliation.yaml';

export interface PendingReconciliationEntry {
  opened_at: string;
  layer: string;
  kind: string;
  description: string;
  source_commit: string;
}

export type ReconciliationFlagAction = 'append' | 'refresh' | 'skip-duplicate';

export interface ReconciliationFlagPlanEntry extends PendingReconciliationEntry {
  action: ReconciliationFlagAction;
}

export interface ReconciliationFlagPlan {
  ok: true;
  /** HEAD sha at plan time, or null when not resolvable (no repo / no commits). */
  commit_sha: string | null;
  since: string;
  changed_files: string[];
  affected_layers: string[];
  entries: ReconciliationFlagPlanEntry[];
  warnings: string[];
  note: string;
}

export interface ReconciliationFlagResult {
  ok: true;
  appended: number;
  refreshed: number;
  skipped: number;
  entries: PendingReconciliationEntry[];
  note: string;
  warnings: string[];
}

export interface ClearReconciliationOptions {
  layer?: string;
  commit?: string;
}

export interface ClearReconciliationResult {
  ok: true;
  removed: PendingReconciliationEntry[];
  remaining: number;
  note: string;
}

function pendingReconciliationPath(repoRoot: string): string {
  return path.join(repoRoot, PENDING_RECONCILIATION_REL_PATH);
}

function isPendingReconciliationEntry(value: unknown): value is PendingReconciliationEntry {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.layer === 'string' && typeof record.source_commit === 'string';
}

/** Read `.tenbo/.pending-reconciliation.yaml`. Never throws — missing/unreadable/malformed all resolve to `[]`. */
export function readPendingReconciliation(repoRoot: string): PendingReconciliationEntry[] {
  const abs = pendingReconciliationPath(repoRoot);
  if (!existsSync(abs)) return [];
  try {
    const data = parseYamlText(readFileSync(abs, 'utf8')) as { items?: unknown[] } | null;
    const items = Array.isArray(data?.items) ? data!.items : [];
    return items.filter(isPendingReconciliationEntry).map((item) => ({
      opened_at: String(item.opened_at ?? ''),
      layer: item.layer,
      kind: String(item.kind ?? ''),
      description: String(item.description ?? ''),
      source_commit: item.source_commit,
    }));
  } catch {
    return [];
  }
}

/** Write the full entry list. Deletes the file when `entries` is empty (per the schema doc: "When the file empties, delete it."). */
export function writePendingReconciliation(repoRoot: string, entries: PendingReconciliationEntry[]): void {
  const abs = pendingReconciliationPath(repoRoot);
  if (entries.length === 0) {
    if (existsSync(abs)) unlinkSync(abs);
    return;
  }
  mkdirSync(path.dirname(abs), { recursive: true });
  const doc = {
    items: entries.map((e) => ({
      opened_at: e.opened_at,
      layer: e.layer,
      kind: e.kind,
      description: e.description,
      source_commit: e.source_commit,
    })),
  };
  writeFileSync(abs, stringifyYamlText(doc, { lineWidth: 0 }));
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function resolveHeadSha(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Compute (without writing) the pending-reconciliation entries a commit's
 * diff would produce. Defaults `since` to `HEAD~1` — i.e. the diff of the
 * commit just made — which is the shape a post-commit hook needs. Reuses
 * `resolveImpact` for all diff/layer resolution; on a root commit (no
 * `HEAD~1`) `resolveImpact` already fails open with a warning rather than
 * throwing, so this degrades to "no layers affected" rather than erroring.
 */
export function planReconciliationFlag(
  repoRoot: string,
  options: { since?: string; now?: Date } = {},
): ReconciliationFlagPlan {
  const since = options.since ?? 'HEAD~1';
  const now = options.now ?? new Date();
  try {
    // commitOnly: map ONLY the committed range `since..HEAD`, not the
    // working tree — the tree is routinely still dirty right after a
    // commit (partial `git add -p`, untracked scratch/build files), and
    // without this those files get falsely attributed to the commit being
    // flagged. See collectChangedFiles's commitOnly branch in impact.ts.
    const impact = resolveImpact(repoRoot, { since, commitOnly: true });
    const warnings = [...impact.warnings];
    const sha = resolveHeadSha(repoRoot);

    if (!sha) {
      return {
        ok: true,
        commit_sha: null,
        since,
        changed_files: impact.changed_files,
        affected_layers: [],
        entries: [],
        warnings,
        note: 'Not inside a git repository (or no commits yet) — nothing to flag.',
      };
    }

    if (impact.affected_layers.length === 0) {
      return {
        ok: true,
        commit_sha: sha,
        since,
        changed_files: impact.changed_files,
        affected_layers: [],
        entries: [],
        warnings,
        note: 'No layers affected by this commit — nothing to flag.',
      };
    }

    const existing = readPendingReconciliation(repoRoot);
    const openedAt = formatDate(now);
    const shortSha = sha.slice(0, 12);

    const entries: ReconciliationFlagPlanEntry[] = impact.affected_layers.map((affected) => {
      const layerKey = `${affected.scope}:${affected.layer}`;
      const description = `Commit ${shortSha} touched ${affected.changed_files.length} file(s) in ${layerKey} — doc-map may need reconciliation.`;
      const exactDuplicate = existing.find(
        (e) => e.kind === DOC_FLAG_KIND && e.layer === layerKey && e.source_commit === sha,
      );
      if (exactDuplicate) {
        return {
          ...exactDuplicate,
          action: 'skip-duplicate',
        };
      }
      const priorOpen = existing.find((e) => e.kind === DOC_FLAG_KIND && e.layer === layerKey);
      return {
        opened_at: openedAt,
        layer: layerKey,
        kind: DOC_FLAG_KIND,
        description,
        source_commit: sha,
        action: priorOpen ? 'refresh' : 'append',
      };
    });

    const actionable = entries.filter((e) => e.action !== 'skip-duplicate').length;
    return {
      ok: true,
      commit_sha: sha,
      since,
      changed_files: impact.changed_files,
      affected_layers: impact.affected_layers.map((a) => `${a.scope}:${a.layer}`),
      entries,
      warnings,
      note:
        actionable > 0
          ? `${actionable} layer(s) would be flagged for doc reconciliation.`
          : 'All affected layers already flagged for this commit — nothing new to append.',
    };
  } catch (err) {
    return {
      ok: true,
      commit_sha: null,
      since,
      changed_files: [],
      affected_layers: [],
      entries: [],
      warnings: [],
      note: `reconcile flag could not resolve impact: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Apply a plan from `planReconciliationFlag`: merges its entries into
 * `.tenbo/.pending-reconciliation.yaml`. `append` adds a new entry;
 * `refresh` overwrites the single prior open `doc-flag` entry for that layer
 * in place (so a layer never accumulates more than one open doc-flag entry);
 * `skip-duplicate` entries are counted but not written again.
 */
export function applyReconciliationFlag(repoRoot: string, plan: ReconciliationFlagPlan): ReconciliationFlagResult {
  if (plan.entries.length === 0) {
    return { ok: true, appended: 0, refreshed: 0, skipped: 0, entries: [], note: plan.note, warnings: plan.warnings };
  }

  const existing = readPendingReconciliation(repoRoot);
  const next = [...existing];
  const docFlagIndexByLayer = new Map<string, number>();
  existing.forEach((e, idx) => {
    if (e.kind === DOC_FLAG_KIND) docFlagIndexByLayer.set(e.layer, idx);
  });

  let appended = 0;
  let refreshed = 0;
  let skipped = 0;
  const written: PendingReconciliationEntry[] = [];

  for (const planEntry of plan.entries) {
    const { action: _action, ...entry } = planEntry;
    if (planEntry.action === 'skip-duplicate') {
      skipped++;
      continue;
    }
    const existingIdx = docFlagIndexByLayer.get(entry.layer);
    if (planEntry.action === 'refresh' && existingIdx !== undefined) {
      next[existingIdx] = entry;
      refreshed++;
    } else {
      next.push(entry);
      docFlagIndexByLayer.set(entry.layer, next.length - 1);
      appended++;
    }
    written.push(entry);
  }

  writePendingReconciliation(repoRoot, next);

  return {
    ok: true,
    appended,
    refreshed,
    skipped,
    entries: written,
    note: `${appended} appended, ${refreshed} refreshed, ${skipped} already present.`,
    warnings: plan.warnings,
  };
}

/**
 * Remove pending-reconciliation entries matching `layer` and/or
 * `source_commit` (AND'ed when both given). Used to clear a doc-flag once
 * the corresponding doc update lands. Deletes the file entirely once empty.
 */
export function clearPendingReconciliation(
  repoRoot: string,
  options: ClearReconciliationOptions,
): ClearReconciliationResult {
  const existing = readPendingReconciliation(repoRoot);
  if (!options.layer && !options.commit) {
    return {
      ok: true,
      removed: [],
      remaining: existing.length,
      note: 'No --layer or --commit filter given — nothing removed.',
    };
  }

  const removed: PendingReconciliationEntry[] = [];
  const remaining: PendingReconciliationEntry[] = [];
  for (const entry of existing) {
    const layerMatch = options.layer ? entry.layer === options.layer : true;
    const commitMatch = options.commit ? entry.source_commit === options.commit : true;
    if (layerMatch && commitMatch) {
      removed.push(entry);
    } else {
      remaining.push(entry);
    }
  }

  writePendingReconciliation(repoRoot, remaining);

  return {
    ok: true,
    removed,
    remaining: remaining.length,
    note: `${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} removed; ${remaining.length} remaining.`,
  };
}
