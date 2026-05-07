import type { Item, Scope } from '../../../types';
import type { Finding } from './types';

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

/**
 * Surfaces `later` items that are >30 days old and reference at least one
 * done/dropped item (via spawned_from, superseded_by, or related).
 * These are likely stale — either they should be dropped, completed, or
 * explicitly re-justified with an updated note.
 */
export function analyzeAgingSuperseded(
  scope: Scope,
  allItems: Map<string, Item>,
  now: number = Date.now(),
): Finding[] {
  const findings: Finding[] = [];

  for (const item of scope.items) {
    if (item.status !== 'later') continue;

    const ageDays = itemAgeDays(item, now);
    if (ageDays < 30) continue;

    const refs = collectReferences(item);
    if (refs.length === 0) continue;

    const referencedDoneOrDropped = refs
      .map(id => allItems.get(id))
      .filter((ref): ref is Item => ref !== undefined && (ref.status === 'done' || ref.status === 'dropped'))
      .map(ref => ({ id: ref.id, status: ref.status }));

    if (referencedDoneOrDropped.length === 0) continue;

    findings.push({
      id: `${item.layer ?? scope.id}.aging-superseded.${item.id}`,
      signal: 'aging-superseded',
      severity: ageDays > 90 ? 'warning' : 'info',
      confidence: 'medium',
      layer: item.layer ?? scope.layers[0]?.id ?? scope.id,
      target: item.id,
      headline: `"${item.title}" is ${ageDays}d old in later, references ${referencedDoneOrDropped.length} done/dropped item(s)`,
      suggestion: {
        summary: 'Mark dropped, mark done, or update with a note explaining the delay',
        rationale: `This item has been in "later" for ${ageDays} days and references items that have already shipped or been dropped. It may be stale.`,
        action_kind: 'triage-item',
      },
      details: {
        kind: 'aging-superseded',
        item_id: item.id,
        item_title: item.title,
        age_days: ageDays,
        referenced_items: referencedDoneOrDropped,
      },
    });
  }

  return findings;
}

function collectReferences(item: Item): string[] {
  const refs: string[] = [];
  if (item.spawned_from) refs.push(item.spawned_from);
  if (item.superseded_by) refs.push(item.superseded_by);
  if (item.related) refs.push(...item.related);
  return refs;
}

function itemAgeDays(item: Item, now: number): number {
  const docUpdate = item.doc_update;
  if (docUpdate && /^\d{4}-\d{2}-\d{2}$/.test(docUpdate)) {
    const ts = new Date(docUpdate).getTime();
    return Math.floor((now - ts) / (24 * 3600 * 1000));
  }
  return THIRTY_DAYS_MS / (24 * 3600 * 1000) + 1; // assume old enough if no date
}
