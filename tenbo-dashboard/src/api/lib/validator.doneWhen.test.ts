import { describe, it, expect } from 'vitest';
import { validate } from './validator';
import { MAX_CHECK_RUN_LENGTH, MAX_TIMEOUT_MS } from './doneWhenChecks';
import type { TenboState, Item } from '../../types';

function stateWithItems(items: Item[]): TenboState {
  return {
    scopes: [{
      id: 'e',
      path: '.',
      description: 'editor scope description here for tests',
      layers: [{ id: 'l', name: 'L', description: 'a small layer for testing now', files: ['x'] } as any],
      items,
    }],
    crossCutting: [],
    narratives: { 'e/l': '# L' },
  } as any;
}

const baseItem = (over: Partial<Item> = {}): Item => ({
  id: 'ed-001',
  title: 't',
  layer: 'l',
  status: 'now',
  description: 'a roadmap item used for done_when shape tests',
  done_when: ['it works'],
  goal_ref: 'exploratory',
  ...over,
});

const errorsFor = (state: TenboState, id: string) =>
  validate(state).errors.filter((e) => e.itemId === id).map((e) => e.message);

describe('validator — done_when shape (x-003)', () => {
  it('accepts an all-string done_when list unchanged (backwards-compatible)', () => {
    const state = stateWithItems([baseItem({ done_when: ['First bullet.', 'Second bullet.'] })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.filter((m) => m.includes('done_when'))).toEqual([]);
  });

  it('accepts a structured entry with a full check', () => {
    const state = stateWithItems([baseItem({
      done_when: [{ text: 'passes the check', check: { run: 'true', expect_exit: 0, timeout_ms: 5000 } }] as any,
    })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.filter((m) => m.includes('done_when'))).toEqual([]);
  });

  it('accepts a structured entry with only run (defaults for expect_exit/timeout_ms)', () => {
    const state = stateWithItems([baseItem({
      done_when: [{ text: 'minimal check', check: { run: 'true' } }] as any,
    })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.filter((m) => m.includes('done_when'))).toEqual([]);
  });

  it('accepts a structured entry with text but no check (manual, structured form)', () => {
    const state = stateWithItems([baseItem({
      done_when: [{ text: 'no check here' }] as any,
    })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.filter((m) => m.includes('done_when'))).toEqual([]);
  });

  it('accepts a mixed list of plain strings and structured entries', () => {
    const state = stateWithItems([baseItem({
      done_when: ['Plain bullet.', { text: 'Structured bullet', check: { run: 'true' } }] as any,
    })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.filter((m) => m.includes('done_when'))).toEqual([]);
  });

  it('errors when done_when is not a list', () => {
    const state = stateWithItems([baseItem({ done_when: 'not a list' as any })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('done_when must be a list'))).toBe(true);
  });

  it('errors when a structured entry is missing text', () => {
    const state = stateWithItems([baseItem({
      done_when: [{ check: { run: 'true' } }] as any,
    })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('missing a non-empty string "text"'))).toBe(true);
  });

  it('errors when check is not an object', () => {
    const state = stateWithItems([baseItem({
      done_when: [{ text: 'bad check', check: 'true' }] as any,
    })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('done_when[0].check must be an object'))).toBe(true);
  });

  it('errors when check.run is missing or empty', () => {
    const state = stateWithItems([baseItem({
      done_when: [{ text: 'no run', check: {} }] as any,
    })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('check.run must be a non-empty string'))).toBe(true);
  });

  it('errors when check.expect_exit is not an integer', () => {
    const state = stateWithItems([baseItem({
      done_when: [{ text: 'bad exit', check: { run: 'true', expect_exit: 1.5 } }] as any,
    })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('check.expect_exit must be an integer'))).toBe(true);
  });

  it('errors when check.timeout_ms is not a positive integer', () => {
    const state = stateWithItems([baseItem({
      done_when: [{ text: 'bad timeout', check: { run: 'true', timeout_ms: -5 } }] as any,
    })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('check.timeout_ms must be a positive integer'))).toBe(true);
  });

  it('errors when check.timeout_ms exceeds the hard cap', () => {
    const state = stateWithItems([baseItem({
      done_when: [{ text: 'too long', check: { run: 'true', timeout_ms: MAX_TIMEOUT_MS + 1 } }] as any,
    })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes(`exceeds the ${MAX_TIMEOUT_MS}ms cap`))).toBe(true);
  });

  it('errors when check.run exceeds the length cap', () => {
    const state = stateWithItems([baseItem({
      done_when: [{ text: 'too long a command', check: { run: 'true;'.repeat(MAX_CHECK_RUN_LENGTH) } }] as any,
    })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes(`exceeds the ${MAX_CHECK_RUN_LENGTH}-char cap`))).toBe(true);
  });

  it('accepts check.run right at the length cap', () => {
    const state = stateWithItems([baseItem({
      done_when: [{ text: 'at the cap', check: { run: 'a'.repeat(MAX_CHECK_RUN_LENGTH) } }] as any,
    })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.filter((m) => m.includes('done_when'))).toEqual([]);
  });

  it('errors when a done_when entry is neither a string nor an object', () => {
    const state = stateWithItems([baseItem({ done_when: [42] as any })]);
    const msgs = errorsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('done_when[0] must be a string or an object'))).toBe(true);
  });
});
