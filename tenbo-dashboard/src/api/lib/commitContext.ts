/**
 * commitContext.ts — propose roadmap item refs + a draft commit message from
 * the pending git diff (td-025).
 *
 * Reuses `resolveImpact` for all git-diff collection and layer/item matching
 * (no re-derivation here). This module only ranks the already-scored
 * `related_items` into commit-facing suggestions and formats a draft message.
 *
 * Deterministic + bounded + fail-open: an empty/absent diff, a missing
 * `.tenbo/` tree, or any unexpected error all resolve to `ok: true` with
 * empty suggestions and a human-readable `note` — this function never throws.
 */
import { resolveImpact } from './impact';
import { readState } from './tenboFs';
import type { Item, TenboState } from '../../types';

export interface CommitContextSuggestion {
  id: string;
  scope: string;
  title: string;
  /** Roadmap status at read time, or 'unknown' if the item couldn't be re-resolved. */
  status: string;
  /** Why this item matched — layer/file/spec-link intersection (from impact scoring). */
  reason: string;
}

export interface CommitContext {
  ok: true;
  changed_files: string[];
  suggestions: CommitContextSuggestion[];
  /** Multi-line draft commit message (subject + blank line + body), or null with no signal. */
  draft_message: string | null;
  /** Short plain-text block suitable for a prepare-commit-msg hook to prepend, or null. */
  hook_format: string | null;
  note: string;
  warnings: string[];
}

const TYPE_PREFIX: Record<string, string> = {
  feature: 'feat',
  bug: 'fix',
  refactor: 'refactor',
  spike: 'spike',
};

const SUBJECT_MAX = 72;
const MAX_BODY_ITEMS = 3;

function truncate(subject: string, max = SUBJECT_MAX): string {
  const chars = Array.from(subject);
  if (chars.length <= max) return subject;
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

function lowerFirst(value: string): string {
  return value.length ? value[0].toLowerCase() + value.slice(1) : value;
}

/**
 * Collapse newlines/control chars to a single space so a hostile/careless
 * `title` or `reason` (no schema constraint forbids `\n`) can't inject a
 * line into hookFormat that's missing the `#` comment prefix, which would
 * otherwise become real committed content the user never typed.
 */
function sanitizeText(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
}

function findItem(state: TenboState | null, scopeId: string, itemId: string): Item | undefined {
  if (!state) return undefined;
  const scope = state.scopes.find((s) => s.id === scopeId);
  return scope?.items.find((i) => i.id === itemId);
}

function emptyContext(note: string, warnings: string[] = [], changedFiles: string[] = []): CommitContext {
  return {
    ok: true,
    changed_files: changedFiles,
    suggestions: [],
    draft_message: null,
    hook_format: null,
    note,
    warnings,
  };
}

export function resolveCommitContext(repoRoot: string, options: { since?: string } = {}): CommitContext {
  try {
    const impact = resolveImpact(repoRoot, options);
    const warnings = [...impact.warnings];

    if (impact.changed_files.length === 0) {
      return emptyContext('No pending changes detected (clean working tree, or not inside a git repo).', warnings);
    }

    let state: TenboState | null = null;
    try {
      state = readState(repoRoot);
    } catch (err) {
      warnings.push(`could not read roadmap state: ${err instanceof Error ? err.message : String(err)}`);
    }

    const suggestions: CommitContextSuggestion[] = impact.related_items.map((related) => {
      const item = findItem(state, related.scope, related.id);
      return {
        id: sanitizeText(related.id),
        scope: related.scope,
        title: sanitizeText(related.title),
        status: item?.status ?? 'unknown',
        reason: sanitizeText(related.reason),
      };
    });

    if (suggestions.length === 0) {
      const fileCount = impact.changed_files.length;
      const subject = truncate(`chore: update ${fileCount} file${fileCount === 1 ? '' : 's'}`);
      const body =
        'No roadmap item matched by layer/file/spec-link heuristics. If this advances an item, link it manually: tenbo-dashboard item link-commit <id> <sha>.';
      return {
        ok: true,
        changed_files: impact.changed_files,
        suggestions: [],
        draft_message: `${subject}\n\n${body}`,
        hook_format: null,
        note: 'No roadmap items matched the pending diff by layer/file/spec-link heuristics.',
        warnings,
      };
    }

    const primary = suggestions[0];
    const primaryItem = findItem(state, primary.scope, primary.id);
    const prefix = TYPE_PREFIX[primaryItem?.type ?? ''] ?? 'chore';
    const subject = truncate(`${prefix}(${primary.scope}): ${lowerFirst(primary.title)}`);
    const topSuggestions = suggestions.slice(0, MAX_BODY_ITEMS);
    const bodyLines = topSuggestions.map((s) => `Advances ${s.id}: ${s.title}`);
    const draftMessage = [subject, '', ...bodyLines].join('\n');
    const hookFormat = [
      '# tenbo commit-context suggestion (td-025) — review before committing:',
      ...bodyLines.map((line) => `# ${line}`),
    ].join('\n');

    return {
      ok: true,
      changed_files: impact.changed_files,
      suggestions,
      draft_message: draftMessage,
      hook_format: hookFormat,
      note: `${suggestions.length} candidate roadmap item(s) matched the pending diff.`,
      warnings,
    };
  } catch (err) {
    return emptyContext(`commit-context could not resolve the pending diff: ${err instanceof Error ? err.message : String(err)}`);
  }
}
