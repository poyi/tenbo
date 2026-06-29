import type { Item, Priority, Status, VerificationStatus } from '../../types';
import type { LocatedItem } from './roadmapStore';

export interface ItemSummaryRecord {
  id: string;
  title: string;
  status: Status;
  scope: string;
  layer?: string;
  layers?: string[];
  type?: Item['type'];
  priority?: Priority;
  goal_ref?: Item['goal_ref'];
  verification?: VerificationStatus;
  risk_count?: number;
  done_when_count?: number;
  latest_note?: string;
}

export const ITEM_FIELD_NAMES = [
  'id',
  'title',
  'status',
  'scope',
  'layer',
  'layers',
  'type',
  'priority',
  'goal_ref',
  'verification',
  'risk_count',
  'done_when_count',
  'latest_note',
] as const;

export type ItemFieldName = typeof ITEM_FIELD_NAMES[number];

const ITEM_FIELD_SET = new Set<string>(ITEM_FIELD_NAMES);

export function parseItemFields(value: string): ItemFieldName[] {
  const fields = value.split(',').map((field) => field.trim()).filter(Boolean);
  for (const field of fields) {
    if (!ITEM_FIELD_SET.has(field)) throw new Error(`invalid field: ${field}`);
  }
  return fields as ItemFieldName[];
}

function latestNote(notes: string | undefined): string | undefined {
  if (!notes) return undefined;
  const lines = notes.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1)?.replace(/^- /, '');
}

export function summarizeItem(entry: LocatedItem): ItemSummaryRecord {
  const item = entry.item;
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    scope: entry.scopeId,
    ...(item.layer ? { layer: item.layer } : {}),
    ...(item.layers ? { layers: item.layers } : {}),
    ...(item.type ? { type: item.type } : {}),
    ...(item.priority ? { priority: item.priority } : {}),
    ...(item.goal_ref ? { goal_ref: item.goal_ref } : {}),
    ...(item.verification?.status ? { verification: item.verification.status } : {}),
    ...(item.risks ? { risk_count: item.risks.length } : {}),
    ...(item.done_when ? { done_when_count: item.done_when.length } : {}),
    ...(latestNote(item.notes) ? { latest_note: latestNote(item.notes) } : {}),
  };
}

export function projectItem(entry: LocatedItem, fields?: ItemFieldName[]): Partial<ItemSummaryRecord> {
  const summary = summarizeItem(entry);
  if (!fields || fields.length === 0) return summary;
  const projected: Partial<ItemSummaryRecord> = {};
  for (const field of fields) {
    const value = summary[field];
    if (value !== undefined) projected[field] = value as never;
  }
  return projected;
}
