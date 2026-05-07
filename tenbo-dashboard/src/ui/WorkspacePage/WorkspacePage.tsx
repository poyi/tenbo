import type { Route, WorkspaceTab } from '../../router/routes';
import type { TenboState } from '../../types';
import { OverviewTab } from './tabs/OverviewTab';
import { PrinciplesTab } from './tabs/PrinciplesTab';
import { GlossaryTab } from './tabs/GlossaryTab';
import { DecisionsTab } from './tabs/DecisionsTab';
import styles from './WorkspacePage.module.css';

const TABS: WorkspaceTab[] = ['overview', 'principles', 'glossary', 'decisions'];

const TAB_LABELS: Record<WorkspaceTab, string> = {
  'overview': 'Project overview',
  'principles': 'Principles',
  'glossary': 'Glossary',
  'decisions': 'Decisions',
};

export function WorkspacePage(props: { tab: WorkspaceTab; navigate: (r: Route) => void; state: TenboState }) {
  return (
    <div className={styles.page}>
      <nav aria-label="breadcrumb" className={styles.breadcrumb}>
        <span>Project</span>
      </nav>
      <nav className={styles.tabs}>
        {TABS.map((t) => (
          <button key={t} aria-pressed={props.tab === t} onClick={() => props.navigate({ kind: 'docs-project', tab: t })}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>
      <div className={styles.body}>
        {props.tab === 'overview' && <OverviewTab state={props.state} navigate={props.navigate} />}
        {props.tab === 'principles' && <PrinciplesTab state={props.state} />}
        {props.tab === 'glossary' && <GlossaryTab state={props.state} />}
        {props.tab === 'decisions' && <DecisionsTab state={props.state} />}
      </div>
    </div>
  );
}
