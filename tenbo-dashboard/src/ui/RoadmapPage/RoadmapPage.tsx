import { useMemo, useState } from 'react';
import { Archive, Columns2, List } from 'lucide-react';
import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { LayerKanban } from '../LayerKanban';
import { TaskList, type FlatItem } from '../TaskList';
import { effectiveStatus } from '../../api/lib/phases';
import { tenboApi } from '../../api/client';
import type { Route } from '../../router/routes';
import type { Item, Layer, Status, TenboState } from '../../types';
import { ArchivedIdsContext } from '../ArchivedContext';
import styles from './RoadmapPage.module.css';

const GENERAL_SCOPE = 'general';
const GENERAL_LAYER: Layer = {
  id: 'general',
  name: 'General / cross-cutting',
  description: 'Items that span scopes or do not fit a single layer.',
  files: [],
};

function layersInRenderOrder(layers: Layer[]): Array<{ layer: Layer; depth: number }> {
  const out: Array<{ layer: Layer; depth: number }> = [];
  const tops = layers.filter((l) => !l.parent);
  for (const top of tops) {
    out.push({ layer: top, depth: 0 });
    for (const child of layers.filter((l) => l.parent === top.id)) {
      out.push({ layer: child, depth: 1 });
    }
  }
  return out;
}

interface Props {
  state: TenboState;
  scopeFilter: string | undefined;
  layerFilter: string | undefined;
  navigate: (r: Route) => void;
  onCardClick: (scopeId: string, item: Item) => void;
  onPatch: (scopeId: string, itemId: string, patch: Partial<Item>) => Promise<void>;
}

export function RoadmapPage({ state, scopeFilter, layerFilter, navigate, onCardClick, onPatch }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [view, setView] = useState<'kanban' | 'list'>('kanban');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  /** IDs of archived items so we can tag them visually. */
  const archivedIds = useMemo(() => {
    const s = new Set<string>();
    for (const scope of state.scopes) for (const i of scope.archivedItems ?? []) s.add(i.id);
    return s;
  }, [state]);

  const totalArchived = archivedIds.size;

  const itemBySource = useMemo(() => {
    const m = new Map<string, { scopeId: string; item: Item }>();
    for (const s of state.scopes) {
      for (const i of s.items) m.set(i.id, { scopeId: s.id, item: i });
      if (showArchived) for (const i of s.archivedItems ?? []) m.set(i.id, { scopeId: s.id, item: i });
    }
    return m;
  }, [state, showArchived]);

  const crossCuttingItems = state.crossCuttingRoadmap ?? [];
  const showGeneral = !scopeFilter || scopeFilter === GENERAL_SCOPE;
  const showScopes = !scopeFilter || scopeFilter !== GENERAL_SCOPE;
  const visibleScopes = showScopes
    ? (scopeFilter ? state.scopes.filter((s) => s.id === scopeFilter) : state.scopes)
    : [];
  const visibleGeneral = showGeneral && !layerFilter ? crossCuttingItems : [];
  const q = search.toLowerCase();
  const matchesSearch = (item: Item) =>
    !q ||
    item.id.toLowerCase().includes(q) ||
    item.title.toLowerCase().includes(q) ||
    (item.description ?? '').toLowerCase().includes(q);

  /** Merge active + archived items per scope when toggle is on. */
  const scopeItems = (s: typeof state.scopes[number]) =>
    showArchived ? [...s.items, ...(s.archivedItems ?? [])] : s.items;

  const allItems = [
    ...visibleScopes.flatMap((s) => scopeItems(s)).filter((i) => (!layerFilter || i.layer === layerFilter) && matchesSearch(i)),
    ...visibleGeneral.filter(matchesSearch),
  ];

  const flatItems = useMemo<FlatItem[]>(() => {
    const result: FlatItem[] = [];
    for (const scope of visibleScopes) {
      const layerMap = new Map(scope.layers.map(l => [l.id, l.name]));
      for (const item of scopeItems(scope)) {
        if (layerFilter && item.layer !== layerFilter) continue;
        if (!matchesSearch(item)) continue;
        result.push({ item, scopeId: scope.id, layerName: item.layer ? layerMap.get(item.layer) : undefined });
      }
    }
    for (const item of visibleGeneral) {
      if (matchesSearch(item)) result.push({ item, scopeId: GENERAL_SCOPE });
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, scopeFilter, layerFilter, search, showArchived]);

  const handleDragEnd = async (e: DragEndEvent) => {
    const activeId = String(e.active.id);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!overId) return;
    const meta = itemBySource.get(activeId);
    if (!meta) return;

    if (overId.includes('::')) {
      const [, status] = overId.split('::');
      if (meta.item.status !== status) {
        await onPatch(meta.scopeId, activeId, { status: status as Status });
      }
    } else {
      const scope = state.scopes.find((s) => s.id === meta.scopeId)!;
      const orderedIds = scope.items.map((i) => i.id);
      const fromIdx = orderedIds.indexOf(activeId);
      const toIdx = orderedIds.indexOf(overId);
      if (fromIdx === -1 || toIdx === -1) return;
      orderedIds.splice(toIdx, 0, orderedIds.splice(fromIdx, 1)[0]);
      await tenboApi.reorder(meta.scopeId, orderedIds);
    }
  };

  return (
    <ArchivedIdsContext.Provider value={archivedIds}>
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className={styles.stickyBar}>
        <RoadmapFilterBar
          scopes={state.scopes}
          scopeFilter={scopeFilter}
          layerFilter={layerFilter}
          navigate={navigate}
          view={view}
          onViewChange={setView}
          allItems={allItems}
          search={search}
          onSearchChange={setSearch}
          showArchived={showArchived}
          onToggleArchived={() => setShowArchived((v) => !v)}
          archivedCount={totalArchived}
        />
      </div>
      <main style={{ padding: view === 'list' ? '16px 0 0' : 16 }}>
        {view === 'list' ? (
          <TaskList
            items={flatItems}
            onRowClick={(scopeId, item) => onCardClick(scopeId, item)}
          />
        ) : (
          <>
            {visibleScopes.map((scope) => (
              <section key={scope.id}>
                {!scopeFilter && <h3 style={{ marginTop: 16 }}>{scope.id}</h3>}
                {layersInRenderOrder(scope.layers)
                  .filter(({ layer }) => !layerFilter || layer.id === layerFilter)
                  .map(({ layer, depth }) => (
                    <LayerKanban
                      key={layer.id}
                      layer={layer}
                      depth={depth}
                      alwaysOpen={!!layerFilter}
                      items={scopeItems(scope).filter((i) => i.layer === layer.id && matchesSearch(i))}
                      onCardClick={(item) => onCardClick(scope.id, item)}
                      onTitleEdit={(id, title) => onPatch(scope.id, id, { title })}
                      onDescEdit={(id, desc) => onPatch(scope.id, id, { description: desc })}
                    />
                  ))}
              </section>
            ))}
            {visibleGeneral.length > 0 && (
              <section>
                {!scopeFilter && <h3 style={{ marginTop: 16 }}>{GENERAL_SCOPE}</h3>}
                <LayerKanban
                  layer={GENERAL_LAYER}
                  items={visibleGeneral.filter(matchesSearch)}
                  onCardClick={(item) => onCardClick(GENERAL_SCOPE, item)}
                  onTitleEdit={() => {}}
                  onDescEdit={() => {}}
                />
              </section>
            )}
          </>
        )}
      </main>
    </DndContext>
    </ArchivedIdsContext.Provider>
  );
}

function RoadmapFilterBar({ scopes, scopeFilter, layerFilter, navigate, view, onViewChange, allItems, search, onSearchChange, showArchived, onToggleArchived, archivedCount }: {
  scopes: TenboState['scopes'];
  scopeFilter: string | undefined;
  layerFilter: string | undefined;
  navigate: (r: Route) => void;
  view: 'kanban' | 'list';
  onViewChange: (v: 'kanban' | 'list') => void;
  allItems: Item[];
  search: string;
  onSearchChange: (v: string) => void;
  showArchived: boolean;
  onToggleArchived: () => void;
  archivedCount: number;
}) {
  const activeScope = scopeFilter && scopeFilter !== GENERAL_SCOPE ? scopes.find((s) => s.id === scopeFilter) : undefined;
  const counts = { now: 0, next: 0, later: 0, done: 0, dropped: 0 };
  for (const i of allItems) counts[effectiveStatus(i)]++;

  return (
    <div className={styles.filterRow}>
      {/* View toggle — far left */}
      <div className={styles.viewToggle} role="group" aria-label="View layout">
        <button
          className={`${styles.viewBtn} ${view === 'kanban' ? styles.viewBtnActive : ''}`}
          onClick={() => onViewChange('kanban')}
          aria-pressed={view === 'kanban'}
          title="Kanban board"
        >
          <Columns2 size={13} strokeWidth={1.75} />
          Kanban
        </button>
        <button
          className={`${styles.viewBtn} ${view === 'list' ? styles.viewBtnActive : ''}`}
          onClick={() => onViewChange('list')}
          aria-pressed={view === 'list'}
          title="Task list"
        >
          <List size={13} strokeWidth={1.75} />
          List
        </button>
      </div>

      <div className={styles.filterDivider} />

      {/* Scope + layer filters */}
      <span className={styles.filterLabel}>Scope</span>
      <select
        value={scopeFilter ?? ''}
        onChange={(e) => navigate({ kind: 'roadmap', scope: e.target.value || undefined })}
      >
        <option value="">All</option>
        {scopes.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        <option value={GENERAL_SCOPE}>General / cross-cutting</option>
      </select>
      {activeScope && (
        <>
          <span className={styles.filterLabel}>Layer</span>
          <select
            value={layerFilter ?? ''}
            onChange={(e) => navigate({ kind: 'roadmap', scope: activeScope.id, layer: e.target.value || undefined })}
          >
            <option value="">All layers</option>
            {activeScope.layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </>
      )}

      <input
        className={styles.searchInput}
        type="search"
        placeholder="Search tasks…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        aria-label="Search tasks by title"
      />

      {archivedCount > 0 && (
        <button
          className={`${styles.archiveBtn} ${showArchived ? styles.archiveBtnActive : ''}`}
          onClick={onToggleArchived}
          aria-pressed={showArchived}
          title={showArchived ? 'Hide archived items' : `Show ${archivedCount} archived item${archivedCount === 1 ? '' : 's'}`}
        >
          <Archive size={13} strokeWidth={1.75} />
          {archivedCount}
        </button>
      )}

      {/* Counts — far right */}
      <div className={styles.filterSpacer} />
      <div className={styles.counts}>
        <span className={styles.countNow}>Now <strong>{counts.now}</strong></span>
        <span className={styles.countNext}>Next <strong>{counts.next}</strong></span>
        <span className={styles.countLater}>Later <strong>{counts.later}</strong></span>
        <span className={styles.countDone}>Done <strong>{counts.done}</strong></span>
      </div>
    </div>
  );
}
