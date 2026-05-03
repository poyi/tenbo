import type { ReactNode } from 'react';
import type { Item } from '../../types';
import type { Route } from '../../router/routes';

export function EnrichmentSections({ item, scopeId, navigate }: { item: Item; scopeId: string; navigate: (r: Route) => void }) {
  const affects = item.affects ?? [];
  const sections: ReactNode[] = [];

  if (affects.length > 0) {
    sections.push(
      <Section key="affects" title="Also touches">
        <ul>
          {affects.map((a) => {
            // Same-scope: bare layer id (e.g., "ai-assistant"). Cross-scope: "<scope>:<layer>".
            const [scope, layer] = a.includes(':') ? a.split(':') : [scopeId, a];
            return (
              <li key={a}>
                <button className="link-button" onClick={() => navigate({ kind: 'docs-layer', scopeId: scope, layerId: layer, tab: 'overview' })}>{a}</button>
              </li>
            );
          })}
        </ul>
      </Section>
    );
  }
  if (item.done_when?.length) sections.push(<Section key="done" title="What done looks like"><List items={item.done_when} /></Section>);
  if (item.risks?.length) sections.push(<Section key="risks" title="Risks / unknowns"><List items={item.risks} /></Section>);
  if (item.type) sections.push(<Section key="type" title="Type">{item.type}</Section>);
  if (item.files_to_read?.length) sections.push(<Section key="files" title="Files to read first" engineerOnly><List items={item.files_to_read} /></Section>);

  if (sections.length === 0) return null;
  return <div>{sections}</div>;
}

function Section({ title, children, engineerOnly = false }: { title: string; children: ReactNode; engineerOnly?: boolean }) {
  return (
    <details open={!engineerOnly}>
      <summary>
        <strong>{title}</strong>
        {engineerOnly && <span style={{ fontSize: 11, color: 'var(--muted, #888)', marginLeft: 6 }}>· for engineers</span>}
      </summary>
      {children}
    </details>
  );
}

function List({ items }: { items: string[] }) {
  return <ul>{items.map((x) => <li key={x}>{x}</li>)}</ul>;
}
