import type { LocatedItem } from '../api/lib/roadmapStore';
import type { ItemFiltersDto } from '../contracts/tenbo';
import { CliTenboClient } from './CliTenboClient';

export async function fetchAllCloudItems(
  client: CliTenboClient,
  kind: 'listItems' | 'getWorkQueue',
  filters?: ItemFiltersDto,
): Promise<LocatedItem[]> {
  const located: LocatedItem[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.query({ kind, filters, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
    if (result.kind !== 'itemPage') throw new Error(`expected itemPage, received ${result.kind}`);
    located.push(...result.value.items.map((record) => ({
      scopeId: record.scope_id, filePath: '', item: record.item, archived: record.archived,
    })));
    cursor = result.value.page.has_more ? result.value.page.next_cursor : undefined;
    if (result.value.page.has_more && !cursor) throw new Error('cloud item page was truncated without a continuation cursor');
  } while (cursor);
  return located;
}
