/**
 * Shared helpers for the optional `phases:` field on roadmap items.
 *
 * Roll-up rule (single source of truth, mirrored in the validator and the viewer):
 *   - `dropped` if every phase has status `dropped`
 *   - `done`    if every phase has status `done` OR every phase is in {done, dropped} and at least one is `done`
 *   - `now`     if any phase has status `now`
 *   - else `next`  if any phase has status `next`
 *   - else `later`
 *
 * `dropped` phases are skipped during rollup (they don't count toward done/later)
 * the way they don't count toward in-flight or pending — they're explicit
 * acknowledgements that work won't be completed. An item where one phase shipped
 * and one was dropped is conceptually `done`.
 *
 * Items without `phases:` are unaffected — their explicit `status:` is the source
 * of truth.
 */
import type { Item, Phase, Status } from '../../types';

export const VALID_PHASE_STATUSES: ReadonlySet<Status> = new Set(['now', 'next', 'later', 'done', 'dropped']);

/** YYYY-MM-DD shape check. Does not validate calendar correctness. */
export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Compute a derived item status from a non-empty phase list. */
export function derivePhaseStatus(phases: Phase[]): Status {
  if (phases.length === 0) return 'later';
  if (phases.every((p) => p.status === 'dropped')) return 'dropped';
  if (phases.every((p) => p.status === 'done' || p.status === 'dropped')) return 'done';
  if (phases.some((p) => p.status === 'now')) return 'now';
  if (phases.some((p) => p.status === 'next')) return 'next';
  return 'later';
}

/** Returns the effective status for an item — derived if phases present, else stored. */
export function effectiveStatus(item: Item): Status {
  if (item.phases && item.phases.length > 0) return derivePhaseStatus(item.phases);
  return item.status;
}

export interface PhaseProgress {
  done: number;
  total: number;
  /** Phase currently `now`, if any. Useful for highlighting. */
  active?: Phase;
}

export function phaseProgress(phases: Phase[]): PhaseProgress {
  const done = phases.filter((p) => p.status === 'done').length;
  const active = phases.find((p) => p.status === 'now');
  return { done, total: phases.length, ...(active ? { active } : {}) };
}
