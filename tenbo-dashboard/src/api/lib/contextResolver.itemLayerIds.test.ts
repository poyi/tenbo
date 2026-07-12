import { describe, it, expect } from 'vitest';
import { itemLayerIds } from './contextResolver';
import type { Item } from '../../types';

function item(overrides: Partial<Item>): Item {
  return {
    id: 'rm-000',
    title: 'test item',
    status: 'now',
    description: '',
    ...overrides,
  } as Item;
}

describe('itemLayerIds', () => {
  it('dedupes when affects repeats the item primary layer (the established authoring convention)', () => {
    const it1 = item({ layer: 'data-layer', affects: ['data-layer', 'cli-tools', 'router'] });

    const ids = itemLayerIds(it1);

    expect(ids).toEqual(['data-layer', 'cli-tools', 'router']);
    expect(ids.filter((id) => id === 'data-layer')).toHaveLength(1);
  });

  it('dedupes overlaps between layers and affects', () => {
    const it1 = item({ layer: 'cli-tools', layers: ['cli-tools', 'data-layer'], affects: ['cli-tools', 'data-layer'] });

    const ids = itemLayerIds(it1);

    expect(ids).toEqual(['cli-tools', 'data-layer']);
  });

  it('preserves distinct layer ids with no duplication', () => {
    const it1 = item({ layer: 'router', affects: ['data-layer', 'cli-tools'] });

    expect(itemLayerIds(it1)).toEqual(['router', 'data-layer', 'cli-tools']);
  });

  it('handles items with no layer info', () => {
    expect(itemLayerIds(item({}))).toEqual([]);
  });
});
