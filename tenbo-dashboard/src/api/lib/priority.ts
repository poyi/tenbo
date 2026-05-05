/**
 * priority.ts — sort comparator for roadmap items by priority.
 *
 * Order: p0 (highest) → p1 → p2 → p3 → unset (last). Equal priorities keep
 * their original file-order via Array.sort's ES2019 stable-sort guarantee.
 *
 * Used by both KanbanColumn and TaskList so the kanban + list views share
 * the same priority-first ordering. (td-009)
 *
 * Note: drag-reorder still modifies roadmap.yaml file order; the priority
 * sort applies as a presentational layer on top. Items with identical
 * priority will follow whatever file order the user dragged them into.
 */

import type { Item, Priority } from '../../types';

const RANK: Record<Priority | 'unset', number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
  unset: 4,
};

function rank(item: Item): number {
  return RANK[item.priority ?? 'unset'];
}

/** Compare two items by priority (lower rank wins). Stable on equal priorities. */
export function comparePriority(a: Item, b: Item): number {
  return rank(a) - rank(b);
}

/** Return a copy of `items` sorted by priority (file order preserved on ties). */
export function sortByPriority<T extends Item>(items: T[]): T[] {
  return [...items].sort(comparePriority);
}
