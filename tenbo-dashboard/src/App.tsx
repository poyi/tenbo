import { useEffect, useState } from 'react';
import { TopBar } from './ui/TopBar';
import { EmptyState } from './ui/EmptyState';
import { LayerDrawer } from './ui/LayerDrawer';
import { ItemModal } from './ui/ItemModal';
import { useTenboState } from './hooks/useTenboState';
import { useApiPatch } from './hooks/useApiPatch';
import { tenboApi } from './api/client';
import { useHashRoute } from './router/useHashRoute';
import { modeFromRoute, type Mode } from './router/routes';
import { LayerPage } from './ui/LayerPage/LayerPage';
import { WorkspacePage } from './ui/WorkspacePage/WorkspacePage';
import { ScopePage } from './ui/ScopePage/ScopePage';
import { RoadmapPage } from './ui/RoadmapPage/RoadmapPage';
import { HealthPage } from './ui/HealthPage/HealthPage';
import { LayerDetailPage } from './ui/LayerDetailPage/LayerDetailPage';
import { FindingModal } from './ui/FindingModal';
import { DotGrid } from './ui/DotGrid';
import type { Item, Layer, RelatedDoc } from './types';
import type { Finding } from './api/lib/health/types';

type Overlay =
  | { kind: 'drawer'; scopeId: string; layer: Layer }
  | { kind: 'modal'; scopeId: string; item: Item }
  | null;

export default function App() {
  const { state, loadError, reload, mergeItem, generation } = useTenboState();
  const patch = useApiPatch();
  const { route, navigate } = useHashRoute();

  const [overlay, setOverlay] = useState<Overlay>(null);
  const [related, setRelated] = useState<RelatedDoc[]>([]);
  const [openFinding, setOpenFinding] = useState<Finding | null>(null);

  useEffect(() => {
    tenboApi.getRelated().then(setRelated).catch(() => {});
  }, [state]);

  // Keep overlay item in sync with refreshed state
  useEffect(() => {
    if (!state || overlay?.kind !== 'modal') return;
    const scope = state.scopes.find(s => s.id === overlay.scopeId);
    const fresh = scope?.items.find(i => i.id === overlay.item.id)
      ?? state.crossCuttingRoadmap?.find(i => i.id === overlay.item.id);
    if (fresh && fresh !== overlay.item) {
      setOverlay({ kind: 'modal', scopeId: overlay.scopeId, item: fresh });
    }
  }, [state]);

  if (loadError && loadError.includes('404')) return <EmptyState message="No .tenbo/ found at the repo root." />;
  if (loadError) return <div style={{ padding: 24, color: 'var(--error)' }}>Error: {loadError} <button onClick={reload}>retry</button></div>;
  if (!state) return <div style={{ padding: 24 }}>Loading…</div>;

  const mode = modeFromRoute(route);
  const onSelectMode = (m: Mode) => {
    if (m === mode) return;
    if (m === 'roadmap') navigate({ kind: 'roadmap' });
    else if (m === 'health') navigate({ kind: 'health' });
    else navigate({ kind: 'docs-project', tab: 'overview' });
  };

  // After PATCH the server returns the canonical item; merge into local
  // state immediately rather than waiting for the SSE-triggered full reload
  // (the SSE echo is filtered by origin token in useTenboState). td-005.
  const handlePatch = async (scopeId: string, itemId: string, p: Partial<Item>) => {
    const updated = await patch(scopeId, itemId, p);
    mergeItem(scopeId, updated);
  };

  const body = (() => {
    if (route.kind === 'docs-project') return <WorkspacePage tab={route.tab} navigate={navigate} state={state} />;
    if (route.kind === 'docs-layer') return <LayerPage scopeId={route.scopeId} layerId={route.layerId} tab={route.tab} navigate={navigate} state={state} generation={generation} />;
    if (route.kind === 'docs-scope') return <ScopePage scopeId={route.scopeId} state={state} navigate={navigate} />;
    if (route.kind === 'item') return <WorkspacePage tab="overview" navigate={navigate} state={state} />;
    if (route.kind === 'health') return (
      <HealthPage
        state={state}
        onSelectLayer={(scopeId, layerId) => navigate({ kind: 'health-layer', scopeId, layerId })}
        onSelectFinding={setOpenFinding}
      />
    );
    if (route.kind === 'health-layer') return (
      <LayerDetailPage
        state={state}
        scopeId={route.scopeId}
        layerId={route.layerId}
        onBack={() => navigate({ kind: 'health' })}
        onSelectFinding={setOpenFinding}
      />
    );
    const scopeFilter = route.kind === 'roadmap' ? route.scope : undefined;
    const layerFilter = route.kind === 'roadmap' ? route.layer : undefined;
    return (
      <RoadmapPage
        state={state}
        scopeFilter={scopeFilter}
        layerFilter={layerFilter}
        navigate={navigate}
        onCardClick={(scopeId, item) => setOverlay({ kind: 'modal', scopeId, item })}
        onPatch={handlePatch}
      />
    );
  })();

  return (
    <>
      <DotGrid />
      <TopBar
        mode={mode}
        onSelectMode={onSelectMode}
        onReload={reload}
      />
      {body}
      {overlay?.kind === 'drawer' && (
        <LayerDrawer
          scopeId={overlay.scopeId}
          layer={overlay.layer}
          narrative={state.narratives[`${overlay.scopeId}/${overlay.layer.id}`] ?? null}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay?.kind === 'modal' && (
        <ItemModal
          item={overlay.item}
          scopeId={overlay.scopeId}
          layers={state.scopes.find(s => s.id === overlay.scopeId)?.layers ?? []}
          relatedDocs={related}
          state={state}
          onClose={() => setOverlay(null)}
          onPatch={async (p) => {
            const updated = await patch(overlay.scopeId, overlay.item.id, p);
            mergeItem(overlay.scopeId, updated);
            // Refresh the overlay's snapshot of the item so subsequent edits
            // (and the "keep overlay in sync" effect above) see the latest.
            setOverlay({ kind: 'modal', scopeId: overlay.scopeId, item: updated });
          }}
          onOpenFile={(path) => { tenboApi.openFile(path).catch(() => {}); }}
          onPromoteRelated={async (path) => {
            const cur = overlay.item.links ?? [];
            if (!cur.includes(path)) {
              const updated = await patch(overlay.scopeId, overlay.item.id, { links: [...cur, path] });
              mergeItem(overlay.scopeId, updated);
              setOverlay({ kind: 'modal', scopeId: overlay.scopeId, item: updated });
            }
          }}
          onSelectItem={(sId, it) => {
            // Cross-cutting items don't carry a scope — fall back to current scope
            // so the modal still has a sensible scope for layer dropdowns.
            setOverlay({ kind: 'modal', scopeId: sId ?? overlay.scopeId, item: it });
          }}
          navigate={navigate}
        />
      )}
      <FindingModal
        finding={openFinding}
        allFindings={Object.values(state.metrics ?? {}).flatMap(m => m.findings ?? [])}
        onClose={() => setOpenFinding(null)}
        onOpenFile={(path) => { tenboApi.openFile(path).catch(() => {}); }}
        onSelectFinding={setOpenFinding}
      />
    </>
  );
}
