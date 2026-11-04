import type { Item } from '../types';
import type { ItemRecordDto, TenboCommandResult, TenboQueryResult } from '../contracts/tenbo';
import { normalizeNotes } from '../api/lib/notes';

/**
 * Cloud storage may serialize notes as a JSON array while Tenbo's internal
 * Item model deliberately uses one markdown string. Normalize that external
 * representation once, before an HTTP result enters the typed domain.
 */
function normalizeItemRecord(record: ItemRecordDto): ItemRecordDto {
  const rawItem = record.item as Item & { notes?: unknown };
  const normalizedNotes = normalizeNotes(rawItem.notes);
  const { notes: _rawNotes, ...item } = rawItem;
  return {
    ...record,
    item: {
      ...item,
      ...(normalizedNotes ? { notes: normalizedNotes } : {}),
    },
  };
}

export function normalizeCloudQueryResult(value: unknown): TenboQueryResult {
  const result = value as TenboQueryResult;
  if (result.kind === 'item') return { ...result, value: normalizeItemRecord(result.value) };
  if (result.kind === 'itemPage') {
    return {
      ...result,
      value: {
        ...result.value,
        items: result.value.items.map(normalizeItemRecord),
      },
    };
  }
  return result;
}

export function normalizeCloudCommandResult(value: unknown): TenboCommandResult {
  const result = value as TenboCommandResult;
  if (result.kind !== 'item') return result;
  return { ...result, value: normalizeItemRecord(result.value) };
}
