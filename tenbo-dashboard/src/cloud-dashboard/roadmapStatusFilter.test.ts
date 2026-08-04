import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROADMAP_STATUS_PRESET,
  boardStatusesForPreset,
  statusFilterForPreset,
} from './roadmapStatusFilter';

describe('cloud roadmap status filters', () => {
  it('defaults bounded reads and board columns to actionable work', () => {
    expect(DEFAULT_ROADMAP_STATUS_PRESET).toBe('open');
    expect(statusFilterForPreset(DEFAULT_ROADMAP_STATUS_PRESET)).toEqual(['now', 'next', 'later']);
    expect(boardStatusesForPreset(DEFAULT_ROADMAP_STATUS_PRESET)).toEqual(['now', 'next', 'later']);
  });

  it('keeps historical and unfiltered views explicit', () => {
    expect(statusFilterForPreset('done')).toBe('done');
    expect(boardStatusesForPreset('done')).toEqual(['done']);
    expect(statusFilterForPreset('all')).toBeUndefined();
    expect(boardStatusesForPreset('all')).toEqual(['now', 'next', 'later', 'done', 'dropped']);
  });

  it('filters historical records before the first bounded page', () => {
    const fixture = [
      ...Array.from({ length: 101 }, (_, index) => ({ id: `x-done-${index}`, status: 'done' as const })),
      { id: 'x-new-later', status: 'later' as const },
    ];
    const openStatuses = statusFilterForPreset(DEFAULT_ROADMAP_STATUS_PRESET)!;

    const firstPage = fixture
      .filter((record) => openStatuses.includes(record.status))
      .slice(0, 50);

    expect(firstPage.map((record) => record.id)).toEqual(['x-new-later']);
  });
});
