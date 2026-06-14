import { describe, it, expect } from 'vitest';
import { validate } from './validator';
import type { Item, TenboState } from '../../types';

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
  status: 'done',
  description: 'a roadmap item used for verification tests',
  ...over,
});

describe('validator — verification field', () => {
  it('accepts supported verification statuses', () => {
    const result = validate(stateWithItems([
      baseItem({ verification: { status: 'pending_live', evidence: ['npm test -- --run'] } }),
    ]));

    expect(result.warnings.some((w) => w.message.includes('verification'))).toBe(false);
  });

  it('warns when verification status is unsupported', () => {
    const result = validate(stateWithItems([
      baseItem({ verification: { status: 'manual' as any } }),
    ]));

    expect(result.warnings.some((w) => w.message.includes('verification.status must be one of'))).toBe(true);
  });

  it('warns when verification evidence is not a string array', () => {
    const result = validate(stateWithItems([
      baseItem({ verification: { status: 'verified', evidence: [1 as any] } }),
    ]));

    expect(result.warnings.some((w) => w.message.includes('verification.evidence must be a string array'))).toBe(true);
  });
});
