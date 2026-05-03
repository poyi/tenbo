import { ArrowRight } from 'lucide-react';
import type { Route } from '../../router/routes';
import type { Layer, TenboState } from '../../types';
import styles from './ScopePage.module.css';

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

function LayerLink({ layerId, layers, scopeId, navigate }: {
  layerId: string;
  layers: Layer[];
  scopeId: string;
  navigate: (r: Route) => void;
}) {
  const target = layers.find((l) => l.id === layerId);
  return (
    <button
      className="link-button"
      onClick={() => navigate({ kind: 'docs-layer', scopeId, layerId, tab: 'overview' })}
    >
      {target?.name ?? layerId}
    </button>
  );
}

function joinList(nodes: Array<React.ReactNode>): React.ReactNode {
  return nodes.map((n, i) => (
    <span key={i}>
      {n}
      {i < nodes.length - 1 ? ', ' : ''}
    </span>
  ));
}

export function ScopePage({ scopeId, state, navigate }: { scopeId: string; state: TenboState; navigate: (r: Route) => void }) {
  const scope = state.scopes.find((s) => s.id === scopeId);
  if (!scope) return <div style={{ padding: 24 }}>Scope not found: {scopeId}</div>;

  const ordered = layersInRenderOrder(scope.layers);
  const itemCount = scope.items.length;

  return (
    <div className={styles.page}>
      <nav aria-label="breadcrumb" className={styles.breadcrumb}>
        <button className="link-button" onClick={() => navigate({ kind: 'docs-project', tab: 'overview' })}>Project</button>
        {' / '}
        <span>{scope.id}</span>
      </nav>

      <header className={styles.header}>
        <div style={{ flex: 1 }}>
          <h1 className={styles.title}>{scope.id}</h1>
          <p className={styles.description}>{scope.description}</p>
          <div className={styles.meta}>
            <code>{scope.path}</code> · {scope.layers.length} layers · {itemCount} roadmap items
          </div>
        </div>
        <div className={styles.headerSpacer}>
          <button
            className="outlined-button icon-text"
            onClick={() => navigate({ kind: 'roadmap', scope: scope.id })}
          >
            View roadmap
            <ArrowRight size={14} strokeWidth={1.75} />
          </button>
        </div>
      </header>

      <section>
        <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Layers</h2>
        <ul className={styles.layerList}>
          {ordered.map(({ layer, depth }) => {
            const uses = layer.dependencies?.outbound ?? [];
            const usedBy = layer.dependencies?.inbound ?? [];
            const external = layer.dependencies?.external ?? [];
            return (
              <li
                key={layer.id}
                className={styles.layerItem}
                style={{ paddingLeft: depth * 20 }}
              >
                <button
                  className={`link-button ${styles.layerName}`}
                  onClick={() => navigate({ kind: 'docs-layer', scopeId: scope.id, layerId: layer.id, tab: 'overview' })}
                >
                  {layer.name}
                </button>
                <div className={styles.layerDesc}>{layer.description}</div>
                {(uses.length > 0 || usedBy.length > 0 || external.length > 0) && (
                  <div className={styles.layerDeps}>
                    {uses.length > 0 && (
                      <div>
                        <span className={styles.depLabel}>Uses: </span>
                        {joinList(uses.map((id) => (
                          <LayerLink key={id} layerId={id} layers={scope.layers} scopeId={scope.id} navigate={navigate} />
                        )))}
                      </div>
                    )}
                    {usedBy.length > 0 && (
                      <div>
                        <span className={styles.depLabel}>Used by: </span>
                        {joinList(usedBy.map((id) => (
                          <LayerLink key={id} layerId={id} layers={scope.layers} scopeId={scope.id} navigate={navigate} />
                        )))}
                      </div>
                    )}
                    {external.length > 0 && (
                      <div>
                        <span className={styles.depLabel}>External: </span>
                        <code>{external.join(', ')}</code>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
