import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Cloud, Columns2, History, List, LogOut, RefreshCw, Search } from 'lucide-react';
import type {
  ItemFiltersDto,
  ItemRecordDto,
  MutationHistoryEntryDto,
  DocumentSearchResultDto,
  ProjectRoleDto,
  ProjectSummaryDto,
  TenboDocumentDto,
} from '../contracts/tenbo';
import type { Status } from '../types';
import { CloudAuthProvider, useCloudAuth } from './auth';
import { CloudDashboardClient } from './client';
import type { CloudDashboardConfig } from './config';
import { CloudItemDialog } from './CloudItemDialog';
import {
  DEFAULT_ROADMAP_STATUS_PRESET,
  ROADMAP_STATUS_OPTIONS,
  boardStatusesForPreset,
  statusFilterForPreset,
  statusPresetLabel,
  type RoadmapStatusPreset,
} from './roadmapStatusFilter';
import { useCloudItems, errorMessage } from './useCloudItems';
import styles from './CloudDashboard.module.css';

type Surface = 'roadmap' | 'documents' | 'history';
type View = 'board' | 'list';

export function CloudDashboardApp({ config }: { config: CloudDashboardConfig }) {
  return <CloudAuthProvider config={config}><CloudDashboardSession config={config} /></CloudAuthProvider>;
}

function CloudDashboardSession({ config }: { config: CloudDashboardConfig }) {
  const auth = useCloudAuth();
  const client = useMemo(() => new CloudDashboardClient(
    config.apiUrl,
    config.supabaseAnonKey,
    () => auth.identity,
  ), [config.apiUrl, config.supabaseAnonKey, auth.identity?.accessToken, auth.identity?.userId]);

  if (auth.loading) return <HostedState title="Restoring secure session" detail="Checking the browser's Supabase session…" />;
  if (!auth.session || !auth.identity) return <SignIn />;
  return <AuthenticatedDashboard config={config} client={client} />;
}

function SignIn() {
  const { signIn } = useCloudAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <main className={styles.signInShell} data-tenbo-hosted-contract="x-094-v1">
      <form className={styles.signInCard} onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try { await signIn(email.trim(), password); }
        catch (cause) { setError(errorMessage(cause)); }
        finally { setBusy(false); }
      }}>
        <Cloud size={24} aria-hidden="true" />
        <div><div className={styles.eyebrow}>Cloud source of truth</div><h1>Tenbo</h1></div>
        <p>Sign in with your existing Supabase account. Your project memberships determine what you can see and change.</p>
        {error && <div className={`${styles.stateBanner} ${styles.dangerBanner}`} role="alert">{error}</div>}
        <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <button className={styles.primaryButton} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}

function AuthenticatedDashboard({ config, client }: { config: CloudDashboardConfig; client: CloudDashboardClient }) {
  const auth = useCloudAuth();
  const [projects, setProjects] = useState<ProjectSummaryDto[] | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [surface, setSurface] = useState<Surface>('roadmap');
  const [projectReload, setProjectReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setProjectError(null);
    void client.listProjects({ limit: 30 }).then((page) => {
      if (cancelled) return;
      setProjects(page.projects);
      const permitted = new Set(page.projects.map((project) => project.id));
      const preferred = [selectedId, config.defaultProjectId, localStorage.getItem('tenbo.cloud.project') ?? '', page.projects[0]?.id ?? '']
        .find((candidate) => !!candidate && permitted.has(candidate));
      setSelectedId(preferred ?? '');
    }).catch((cause) => {
      if (!cancelled) setProjectError(errorMessage(cause));
    });
    return () => { cancelled = true; };
  }, [client, config.defaultProjectId, projectReload]);
  const selected = projects?.find((project) => project.id === selectedId);

  if (projectError && !projects) return <HostedState title="Projects unavailable" detail={projectError} action={<button className={styles.primaryButton} onClick={() => setProjectReload((value) => value + 1)}>Retry</button>} />;
  if (!projects) return <HostedState title="Loading permitted projects" detail="Reading your Tenbo memberships…" />;
  if (projects.length === 0) return (
    <HostedState title="No permitted Tenbo projects" detail="Your session is valid, but it has no Tenbo project membership." action={<button className={styles.secondaryButton} onClick={() => auth.signOut()}>Sign out</button>} />
  );

  const chooseProject = (projectId: string) => {
    setSelectedId(projectId);
    localStorage.setItem('tenbo.cloud.project', projectId);
  };

  return (
    <div className={styles.hostedShell} data-tenbo-hosted-contract="x-094-v1">
      <header className={styles.topBar}>
        <a className={styles.brand} href="#" onClick={(event) => { event.preventDefault(); setSurface('roadmap'); }}><Cloud size={17} /><strong>tenbo</strong><span>cloud</span></a>
        <nav className={styles.surfaceNav} aria-label="Project views">
          <SurfaceButton active={surface === 'roadmap'} onClick={() => setSurface('roadmap')} icon={<Columns2 size={15} />} label="Roadmap" />
          <SurfaceButton active={surface === 'documents'} onClick={() => setSurface('documents')} icon={<BookOpen size={15} />} label="Documents" />
          <SurfaceButton active={surface === 'history'} onClick={() => setSurface('history')} icon={<History size={15} />} label="History" />
        </nav>
        <div className={styles.sessionControls}>
          <select aria-label="Tenbo project" value={selectedId} onChange={(event) => chooseProject(event.target.value)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <span className={styles.roleBadge}>{selected?.role}</span>
          <button className={styles.iconButton} onClick={() => auth.signOut()} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>
        </div>
      </header>
      {projectError && <div className={`${styles.stateBanner} ${styles.warningBanner}`} role="status">Membership refresh failed: {projectError}</div>}
      {selected && (
        <>
          {surface === 'roadmap' && <RoadmapSurface key={selected.id} project={selected} client={client} userId={auth.identity!.userId} />}
          {surface === 'documents' && <DocumentsSurface key={selected.id} project={selected} client={client} />}
          {surface === 'history' && <HistorySurface key={selected.id} project={selected} client={client} />}
        </>
      )}
    </div>
  );
}

function RoadmapSurface({ project, client, userId }: { project: ProjectSummaryDto; client: CloudDashboardClient; userId: string }) {
  const [view, setView] = useState<View>('board');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [scopeDraft, setScopeDraft] = useState('');
  const [scope, setScope] = useState('');
  const [statusPreset, setStatusPreset] = useState<RoadmapStatusPreset>(DEFAULT_ROADMAP_STATUS_PRESET);
  const [archived, setArchived] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ItemRecordDto | null>(null);
  const statusFilter = statusFilterForPreset(statusPreset);
  const filters = useMemo<ItemFiltersDto>(() => ({
    archived,
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(search ? { search } : {}),
    ...(scope ? { scope_id: scope } : {}),
  }), [archived, search, scope, statusPreset]);
  const auth = useCloudAuth();
  const state = useCloudItems(client, project.id, filters, auth.supabase);

  const replaceRecord = (next: ItemRecordDto) => {
    setSelectedItem(next);
    void state.reload();
  };
  const openItem = async (record: ItemRecordDto) => {
    try {
      setSelectedItem(await client.getItem(project.id, record.item.id));
    } catch {
      // The compact list record still provides a usable read-only fallback if
      // the detail request is interrupted.
      setSelectedItem(record);
    }
  };

  return (
    <>
      <section className={styles.projectHeader}>
        <div><div className={styles.eyebrow}>Canonical cloud roadmap</div><h1>{project.name}</h1><p>{project.repository} · project version {project.project_version}</p></div>
        <div className={styles.freshness} aria-live="polite">
          <span className={state.partialLiveError ? styles.staleDot : styles.liveDot} />
          {state.partialLiveError ? 'Cached view · live refresh interrupted' : state.refreshedAt ? `Live · refreshed ${state.refreshedAt.toLocaleTimeString()}` : 'Connecting…'}
          <button className={styles.iconButton} onClick={state.reload} aria-label="Refresh roadmap"><RefreshCw size={14} /></button>
        </div>
      </section>

      <form className={styles.filterBar} onSubmit={(event) => { event.preventDefault(); setSearch(searchDraft.trim()); setScope(scopeDraft.trim()); }} role="search">
        <div className={styles.segmented} role="group" aria-label="Roadmap layout">
          <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}><Columns2 size={14} />Board</button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={14} />List</button>
        </div>
        <label className={styles.searchField}><span className="muted-small">Search</span><div><Search size={14} /><input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="ID, title, or intent" /></div></label>
        <label><span className="muted-small">Scope ID</span><input value={scopeDraft} onChange={(event) => setScopeDraft(event.target.value)} placeholder="All scopes" /></label>
        <label><span className="muted-small">Status</span><select aria-label="Roadmap status" value={statusPreset} onChange={(event) => setStatusPreset(event.target.value as RoadmapStatusPreset)}>{ROADMAP_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <button className={styles.secondaryButton}>Apply</button>
        <label className={styles.checkboxLabel}><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />Archived</label>
        <span className={styles.loadedCount}>{state.items.length} loaded{state.page.has_more ? ' · more available' : ''}</span>
      </form>

      {state.partialLiveError && <div className={`${styles.stateBanner} ${styles.warningBanner}`} role="status">Live refresh is partial. Cached items remain usable. {state.partialLiveError}</div>}
      {state.error && <HostedState title="Roadmap unavailable" detail={state.error} action={<button className={styles.primaryButton} onClick={state.reload}>Retry</button>} />}
      {!state.error && state.loading && state.items.length === 0 && <RoadmapSkeleton />}
      {!state.error && !state.loading && state.items.length === 0 && <HostedState title={`No ${statusPresetLabel(statusPreset).toLowerCase()} roadmap items match`} detail={statusPreset === 'all' ? 'Adjust the search, scope, or archive filter.' : 'Adjust the filters, or choose All to search every status.'} />}
      {state.items.length > 0 && (view === 'board'
        ? <RoadmapBoard items={state.items} statuses={boardStatusesForPreset(statusPreset)} onOpen={(record) => void openItem(record)} />
        : <RoadmapList items={state.items} onOpen={(record) => void openItem(record)} />)}
      {state.page.has_more && <div className={styles.loadMore}><button className={styles.secondaryButton} disabled={state.loadingMore} onClick={() => void state.loadMore()}>{state.loadingMore ? 'Loading…' : 'Load next page'}</button></div>}
      {selectedItem && <CloudItemDialog client={client} projectId={project.id} initial={selectedItem} userId={userId} role={project.role} onClose={() => setSelectedItem(null)} onChanged={replaceRecord} />}
    </>
  );
}

function RoadmapBoard({ items, statuses, onOpen }: { items: ItemRecordDto[]; statuses: Status[]; onOpen(item: ItemRecordDto): void }) {
  return <main className={styles.board} aria-label="Roadmap board" style={{ gridTemplateColumns: `repeat(${statuses.length}, minmax(220px, 1fr))` }}>{statuses.map((status) => {
    const records = items.filter((record) => record.item.status === status);
    return <section className={styles.boardColumn} key={status} aria-labelledby={`status-${status}`}><header><h2 id={`status-${status}`}>{status}</h2><span>{records.length}</span></header><div className={styles.cardStack}>{records.map((record) => <ItemCard key={record.item.id} record={record} onOpen={onOpen} />)}{records.length === 0 && <p className={styles.columnEmpty}>No loaded items</p>}</div></section>;
  })}</main>;
}

function RoadmapList({ items, onOpen }: { items: ItemRecordDto[]; onOpen(item: ItemRecordDto): void }) {
  return <main className={styles.listWrap}><table className={styles.itemTable}><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Scope</th><th>Priority</th><th>Version</th></tr></thead><tbody>{items.map((record) => <tr key={record.item.id} tabIndex={0} onClick={() => onOpen(record)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(record); } }}><td><code>{record.item.id}</code></td><td>{record.item.title}</td><td><StatusBadge status={record.item.status} /></td><td>{record.scope_id}</td><td>{record.item.priority ?? '—'}</td><td>{record.version}</td></tr>)}</tbody></table></main>;
}

function ItemCard({ record, onOpen }: { record: ItemRecordDto; onOpen(item: ItemRecordDto): void }) {
  return <button className={styles.itemCard} onClick={() => onOpen(record)}><div className={styles.itemMeta}><code>{record.item.id}</code><span>{record.scope_id}</span></div><strong>{record.item.title}</strong>{record.item.description && <p>{record.item.description}</p>}<div className={styles.itemFoot}><StatusBadge status={record.item.status} /><span>{record.item.priority ?? 'unranked'}</span></div></button>;
}

function DocumentsSurface({ project, client }: { project: ProjectSummaryDto; client: CloudDashboardClient }) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [documents, setDocuments] = useState<DocumentSearchResultDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<TenboDocumentDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = async (cursor?: string) => {
    if (!query) return;
    setBusy(true); setError(null);
    try {
      const result = await client.searchDocuments(project.id, query, undefined, { ...(cursor ? { cursor } : {}) });
      setDocuments((current) => cursor ? [...current, ...result.documents] : result.documents);
      setNextCursor(result.page.next_cursor);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };

  const submit = async (value: string) => { setQuery(value); if (!value) { setDocuments([]); return; } setBusy(true); setError(null); try { const result = await client.searchDocuments(project.id, value, undefined); setDocuments(result.documents); setNextCursor(result.page.next_cursor); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } };
  const openDocument = async (document: DocumentSearchResultDto) => {
    setBusy(true); setError(null);
    try { setSelected(await client.getDocument(project.id, document.id)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const isGit = selected?.source_kind === 'git';

  return <main className={styles.readSurface}><section className={styles.readHeader}><div><div className={styles.eyebrow}>Bounded canonical reads</div><h1>Documents</h1><p>Git documentation remains Git-owned. Specs, workpads, and handoffs are cloud planning documents.</p></div><form role="search" onSubmit={(event) => { event.preventDefault(); void submit(draft.trim()); }}><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Search paths and contents" aria-label="Search documents" /><button className={styles.primaryButton}>Search</button></form></section>{error && <div className={`${styles.stateBanner} ${styles.dangerBanner}`} role="alert">{error}</div>}{!query && <HostedState title="Search project documents" detail="Results are paginated and content loads only when you select a result." />}{query && !busy && documents.length === 0 && <HostedState title="No documents match" detail={`No Git or cloud planning documents matched “${query}”.`} />}{documents.length > 0 && <div className={styles.documentLayout}><ol className={styles.documentList}>{documents.map((document) => <li key={document.id}><button aria-pressed={selected?.id === document.id} onClick={() => void openDocument(document)}><strong>{document.path}</strong><span>{document.source_kind === 'git' ? 'Git-owned · read-only' : `Cloud planning · ${document.kind} · v${document.version}`}</span><small>{document.excerpt}</small></button></li>)}{nextCursor && <li><button className={styles.secondaryButton} disabled={busy} onClick={() => void runSearch(nextCursor)}>Load next page</button></li>}</ol>{selected && <article className={styles.documentViewer}><div className={styles.documentMeta}><strong>{selected.path}</strong><span>{isGit ? `Git · ${(selected as Extract<TenboDocumentDto, { source_kind: 'git' }>).commit_sha.slice(0, 12)}` : `Cloud planning · version ${selected.version}`}</span></div><pre>{selected.content}</pre>{selected.source_kind === 'planning' && project.role !== 'viewer' && <p className={styles.specHint}>Edit planning documents from their roadmap item, where the claim fence and section history stay visible.</p>}</article>}</div>}{busy && <div className={styles.stateBanner} role="status">Loading bounded document page…</div>}</main>;
}

function HistorySurface({ project, client }: { project: ProjectSummaryDto; client: CloudDashboardClient }) {
  const [entries, setEntries] = useState<MutationHistoryEntryDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const load = async (cursor?: string) => { try { const result = await client.history(project.id, undefined, { ...(cursor ? { cursor } : {}) }); setEntries((current) => cursor && current ? [...current, ...result.entries] : result.entries); setNextCursor(result.page.next_cursor); setError(null); } catch (cause) { setError(errorMessage(cause)); } };
  useEffect(() => {
    let cancelled = false;
    void client.history(project.id).then((result) => {
      if (cancelled) return;
      setEntries(result.entries);
      setNextCursor(result.page.next_cursor);
      setError(null);
    }).catch((cause) => { if (!cancelled) setError(errorMessage(cause)); });
    return () => { cancelled = true; };
  }, [client, project.id]);
  return <main className={styles.readSurface}><section className={styles.readHeader}><div><div className={styles.eyebrow}>Immutable audit trail</div><h1>Actor history</h1><p>Human and agent mutations are shown from newest to oldest.</p></div><button className={styles.secondaryButton} onClick={() => void load()}><RefreshCw size={14} />Refresh</button></section>{error && <div className={`${styles.stateBanner} ${styles.dangerBanner}`} role="alert">{error}</div>}{entries === null && <HostedState title="Loading actor history" detail="Reading the newest bounded page…" />}{entries?.length === 0 && <HostedState title="No recorded mutations" detail="This project has no actor history yet." />}{entries && entries.length > 0 && <ol className={styles.auditList}>{entries.map((entry) => <li key={entry.mutation_id}><time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleString()}</time><strong>{entry.operation}</strong><code>{entry.item_id}</code><span>{entry.actor_type ?? 'actor'} · {entry.actor}</span></li>)}</ol>}{nextCursor && <div className={styles.loadMore}><button className={styles.secondaryButton} onClick={() => void load(nextCursor)}>Load older history</button></div>}</main>;
}

function HostedState({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) { return <main className={styles.hostedState} role="status"><Cloud size={22} /><h2>{title}</h2><p>{detail}</p>{action}</main>; }
function RoadmapSkeleton() { return <main className={styles.board} aria-label="Loading roadmap"><div className={styles.skeleton} /><div className={styles.skeleton} /><div className={styles.skeleton} /></main>; }
function SurfaceButton({ active, onClick, icon, label }: { active: boolean; onClick(): void; icon: React.ReactNode; label: string }) { return <button aria-current={active ? 'page' : undefined} onClick={onClick}>{icon}{label}</button>; }
function StatusBadge({ status }: { status: Status }) { return <span className={`${styles.statusBadge} ${styles[`status_${status}`]}`}>{status}</span>; }

export function canEditProject(role: ProjectRoleDto): boolean { return role === 'editor' || role === 'admin'; }
