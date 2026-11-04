import type { Status } from '../types';

export type RoadmapStatusPreset = 'open' | Status | 'all';

export const DEFAULT_ROADMAP_STATUS_PRESET: RoadmapStatusPreset = 'open';

export const ROADMAP_STATUS_OPTIONS: ReadonlyArray<{
  value: RoadmapStatusPreset;
  label: string;
}> = [
  { value: 'open', label: 'Open' },
  { value: 'now', label: 'Now' },
  { value: 'next', label: 'Next' },
  { value: 'later', label: 'Later' },
  { value: 'done', label: 'Done' },
  { value: 'dropped', label: 'Dropped' },
  { value: 'all', label: 'All' },
];

const OPEN_STATUSES: Status[] = ['now', 'next', 'later'];
const ALL_STATUSES: Status[] = ['now', 'next', 'later', 'done', 'dropped'];

export function statusFilterForPreset(preset: RoadmapStatusPreset): Status | Status[] | undefined {
  if (preset === 'open') return OPEN_STATUSES;
  if (preset === 'all') return undefined;
  return preset;
}

export function boardStatusesForPreset(preset: RoadmapStatusPreset): Status[] {
  if (preset === 'open') return OPEN_STATUSES;
  if (preset === 'all') return ALL_STATUSES;
  return [preset];
}

export function statusPresetLabel(preset: RoadmapStatusPreset): string {
  return ROADMAP_STATUS_OPTIONS.find((option) => option.value === preset)?.label ?? 'Open';
}
