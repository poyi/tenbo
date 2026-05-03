import { ArrowRight } from 'lucide-react';
import { useLayerContent } from '../../hooks/useLayerContent';
import { PlainEnglishTab } from './tabs/PlainEnglishTab';
import { IntentTab } from './tabs/IntentTab';
import { CodeMapTab } from './tabs/CodeMapTab';
import { DeepDivesTab } from './tabs/DeepDivesTab';
import type { Route, LayerTab } from '../../router/routes';
import type { TenboState } from '../../types';
import styles from './LayerPage.module.css';

const TABS: LayerTab[] = ['overview', 'purpose', 'files', 'docs'];

const TAB_LABELS: Record<LayerTab, string> = {
  'overview': 'Overview',
  'purpose': 'What it does',
  'files': 'File guide',
  'docs': 'More docs',
};

export function LayerPage(props: {
  scopeId: string;
  layerId: string;
  tab: LayerTab;
  navigate: (r: Route) => void;
  state: TenboState;
  generation: number;
}) {
  const { content, error } = useLayerContent(props.scopeId, props.layerId, props.generation);
  const scope = props.state.scopes.find((s) => s.id === props.scopeId);
  const layer = scope?.layers.find((l) => l.id === props.layerId);

  if (!layer) return <div>Layer not found: {props.scopeId} / {props.layerId}.</div>;
  if (error) return <div>Failed to load layer content: {error}</div>;
  if (!content) return <div>Loading…</div>;

  return (
    <div className={styles.page}>
      <nav aria-label="breadcrumb" className={styles.breadcrumb}>
        <button className="link-button" onClick={() => props.navigate({ kind: 'docs-project', tab: 'overview' })}>Project</button>
        {' / '}
        <button className="link-button" onClick={() => props.navigate({ kind: 'docs-scope', scopeId: props.scopeId })}>{props.scopeId}</button>
        {' / '}
        <span>{layer.name}</span>
      </nav>
      <header className={styles.header}>
        <h1 className={styles.title}>{layer.name}</h1>
        <div className={styles.headerSpacer}>
          <button
            className="outlined-button icon-text"
            onClick={() => props.navigate({ kind: 'roadmap', scope: props.scopeId, layer: props.layerId })}
          >
            View roadmap
            <ArrowRight size={14} strokeWidth={1.75} />
          </button>
        </div>
      </header>
      <nav className={styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t}
            aria-pressed={props.tab === t}
            onClick={() => props.navigate({ kind: 'docs-layer', scopeId: props.scopeId, layerId: props.layerId, tab: t })}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>
      <div className={styles.body}>
        {props.tab === 'overview' && <PlainEnglishTab scopeId={props.scopeId} layerId={props.layerId} content={content.readme} />}
        {props.tab === 'purpose' && <IntentTab scopeId={props.scopeId} layerId={props.layerId} content={content.intentMd} />}
        {props.tab === 'files' && <CodeMapTab scopeId={props.scopeId} layerId={props.layerId} content={content.codeMapMd} />}
        {props.tab === 'docs' && <DeepDivesTab scopeId={props.scopeId} layerId={props.layerId} />}
      </div>
    </div>
  );
}
