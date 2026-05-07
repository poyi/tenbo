import { useCallback } from 'react';
import type { Item } from '../types';
import { tenboApi } from '../api/client';

export function useApiPatch() {
  return useCallback(async (scopeId: string, itemId: string, patch: Partial<Item>): Promise<Item> => {
    const { item } = await tenboApi.patchItem(scopeId, itemId, patch);
    return item;
  }, []);
}
