import { useCallback } from 'react';
import type { Item } from '../types';
import { tenboApi } from '../api/client';

export function useApiPatch() {
  return useCallback((scopeId: string, itemId: string, patch: Partial<Item>) => {
    return tenboApi.patchItem(scopeId, itemId, patch);
  }, []);
}
