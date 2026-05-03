import { Markdown } from '../../Markdown';
import type { Route } from '../../../router/routes';
import type { TenboState } from '../../../types';

export function OverviewTab({ state }: { state: TenboState; navigate: (r: Route) => void }) {
  return (
    <div>
      <Markdown source={state.workspaceContent.overviewMd} />

      {state.crossCutting.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Cross-cutting concerns</h2>
          {state.crossCutting.map((cc) => (
            <div key={cc.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border, #eee)' }}>
              <span style={{ fontSize: 11, color: 'var(--muted, #888)', marginRight: 8 }}>{cc.id}</span>
              <span style={{ fontWeight: 500 }}>{cc.description}</span>
              {cc.spans.length > 0 && (
                <div style={{ fontSize: 12, color: 'var(--muted, #888)', marginTop: 2 }}>
                  Spans: {cc.spans.join(', ')}
                </div>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
