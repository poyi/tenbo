export type WorkspaceTab = typeof WORKSPACE_TABS[number];
export type LayerTab = typeof LAYER_TABS[number];
export type Mode = 'docs' | 'roadmap' | 'health';

const WORKSPACE_TABS = ['overview', 'principles', 'glossary', 'decisions'] as const;
const LAYER_TABS = ['overview', 'purpose', 'files', 'docs'] as const;

export type Route =
  | { kind: 'docs-project'; tab: WorkspaceTab }
  | { kind: 'docs-scope'; scopeId: string }
  | { kind: 'docs-layer'; scopeId: string; layerId: string; tab: LayerTab }
  | { kind: 'roadmap'; scope?: string; layer?: string }
  | { kind: 'health' }
  | { kind: 'health-layer'; scopeId: string; layerId: string }
  | { kind: 'item'; itemId: string }
  | { kind: 'unknown' };

function isWorkspaceTab(s: string | undefined): s is WorkspaceTab {
  return WORKSPACE_TABS.includes(s as WorkspaceTab);
}

function isLayerTab(s: string | undefined): s is LayerTab {
  return LAYER_TABS.includes(s as LayerTab);
}

function splitPathAndQuery(raw: string): { parts: string[]; query: URLSearchParams } {
  const stripped = raw.replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = stripped.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const query = new URLSearchParams(queryPart);
  return { parts, query };
}

export function parseHash(hash: string): Route {
  const { parts, query } = splitPathAndQuery(hash);
  if (parts.length === 0) return { kind: 'roadmap' };

  // Backward-compat redirects from the pre-Phase-1 route shapes.
  if (parts[0] === 'workspace') {
    if (parts[1] === 'cross-cutting') return { kind: 'roadmap' };
    const tab: WorkspaceTab = isWorkspaceTab(parts[1]) ? parts[1] : 'overview';
    return { kind: 'docs-project', tab };
  }
  if (parts[0] === 'scope' && parts[1]) {
    if (parts[2] === 'layer' && parts[3]) {
      const tab: LayerTab = isLayerTab(parts[4]) ? parts[4] : 'overview';
      return { kind: 'docs-layer', scopeId: parts[1], layerId: parts[3], tab };
    }
    return { kind: 'roadmap', scope: parts[1] };
  }

  if (parts[0] === 'docs') {
    if (parts.length === 1) return { kind: 'docs-project', tab: 'overview' };
    if (parts[1] === 'scope' && parts[2]) {
      if (parts[3] === 'layer' && parts[4]) {
        const tab: LayerTab = isLayerTab(parts[5]) ? parts[5] : 'overview';
        return { kind: 'docs-layer', scopeId: parts[2], layerId: parts[4], tab };
      }
      return { kind: 'docs-scope', scopeId: parts[2] };
    }
    const tab: WorkspaceTab = isWorkspaceTab(parts[1]) ? parts[1] : 'overview';
    return { kind: 'docs-project', tab };
  }
  if (parts[0] === 'roadmap') {
    const scope = query.get('scope') ?? undefined;
    const layer = query.get('layer') ?? undefined;
    return { kind: 'roadmap', scope, layer };
  }
  if (parts[0] === 'item' && parts[1]) return { kind: 'item', itemId: parts[1] };
  if (parts[0] === 'health' && parts[1] && parts[2]) return { kind: 'health-layer', scopeId: parts[1], layerId: parts[2] };
  if (parts[0] === 'health') return { kind: 'health' };
  return { kind: 'unknown' };
}

export function formatRoute(r: Route): string {
  switch (r.kind) {
    case 'docs-project': return r.tab === 'overview' ? '#/docs' : `#/docs/${r.tab}`;
    case 'docs-scope': return `#/docs/scope/${r.scopeId}`;
    case 'docs-layer': return `#/docs/scope/${r.scopeId}/layer/${r.layerId}/${r.tab}`;
    case 'roadmap': {
      const params = new URLSearchParams();
      if (r.scope) params.set('scope', r.scope);
      if (r.layer) params.set('layer', r.layer);
      const q = params.toString();
      return q ? `#/roadmap?${q}` : '#/roadmap';
    }
    case 'item': return `#/item/${r.itemId}`;
    case 'health': return '#/health';
    case 'health-layer': return `#/health/${r.scopeId}/${r.layerId}`;
    default: return '#/';
  }
}

export function modeFromRoute(r: Route): Mode {
  if (r.kind === 'roadmap') return 'roadmap';
  if (r.kind === 'health' || r.kind === 'health-layer') return 'health';
  return 'docs';
}
