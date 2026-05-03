import type { Item, TenboState } from '../../types';

export interface ItemRef {
  item: Item;
  scopeId?: string;
}

/**
 * Flatten every roadmap item across all scopes plus the cross-cutting roadmap
 * into a single array of `{ item, scopeId }` references. `scopeId` is undefined
 * for cross-cutting items. Order: scope-by-scope (in `state.scopes` order),
 * then cross-cutting at the end.
 */
export function allItems(state: TenboState): ItemRef[] {
  const out: ItemRef[] = [];
  for (const scope of state.scopes) {
    for (const item of scope.items) out.push({ item, scopeId: scope.id });
  }
  for (const item of state.crossCuttingRoadmap ?? []) out.push({ item });
  return out;
}

/** Find an item by id anywhere in the workspace. Returns null if missing. */
export function findItemById(state: TenboState, id: string): ItemRef | null {
  for (const ref of allItems(state)) {
    if (ref.item.id === id) return ref;
  }
  return null;
}

/**
 * Given a flat list of items, return all items whose `spawned_from` equals `parentId`.
 * Pure function — extracted so it can be tested without constructing a full TenboState.
 */
export function childrenOf(items: Item[], parentId: string): Item[] {
  return items.filter((it) => it.spawned_from === parentId);
}

/**
 * Compute the full set of items related to `target` (deduplicated by id):
 *   - Forward edges: every id in `target.related` that resolves to a known item.
 *   - Reverse edges: every other item whose `related` array contains `target.id`.
 * The target itself is excluded. Order: forward refs first (preserving target.related
 * order), then reverse refs in workspace-iteration order.
 */
export function relatedItems(state: TenboState, target: Item): ItemRef[] {
  const seen = new Set<string>([target.id]);
  const out: ItemRef[] = [];
  for (const ref of target.related ?? []) {
    if (seen.has(ref)) continue;
    const found = findItemById(state, ref);
    if (found) {
      seen.add(ref);
      out.push(found);
    }
  }
  for (const candidate of allItems(state)) {
    if (seen.has(candidate.item.id)) continue;
    if ((candidate.item.related ?? []).includes(target.id)) {
      seen.add(candidate.item.id);
      out.push(candidate);
    }
  }
  return out;
}
