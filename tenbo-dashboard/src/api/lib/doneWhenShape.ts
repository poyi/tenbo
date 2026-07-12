/**
 * doneWhenShape.ts — browser-safe shape helpers for `done_when` entries
 * (x-003). Deliberately has NO Node built-in imports (no `node:child_process`,
 * `node:fs`, etc.) so it can be imported from UI components without pulling
 * server-only code into the Vite browser bundle.
 *
 * `doneWhenChecks.ts` re-exports these and adds the execution machinery —
 * import from there for server/CLI code, and from here for UI code.
 */
import type { DoneWhenEntry, StructuredDoneWhen } from '../../types';

/** Type guard: does this `done_when` entry carry a structured `check`? */
export function isStructuredDoneWhen(entry: DoneWhenEntry): entry is StructuredDoneWhen {
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry) && 'check' in entry && Boolean((entry as StructuredDoneWhen).check);
}

/** Human-readable text for any `done_when` entry, string or structured. */
export function doneWhenText(entry: DoneWhenEntry): string {
  if (typeof entry === 'string') return entry;
  return entry?.text ?? '';
}
