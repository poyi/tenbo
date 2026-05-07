import { createContext, useContext } from 'react';

/**
 * Set of item IDs that came from roadmap-archive.yaml.
 * Provided by RoadmapPage so any descendant (ItemCard, TaskList row)
 * can style archived items without prop drilling.
 */
export const ArchivedIdsContext = createContext<ReadonlySet<string>>(new Set());

export function useArchivedIds(): ReadonlySet<string> {
  return useContext(ArchivedIdsContext);
}
