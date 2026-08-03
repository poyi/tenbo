import { useEffect, useMemo, useState } from 'react';
import { Archive, FileClock, Plus, RotateCcw, Save } from 'lucide-react';
import type {
  DocumentVersionDto,
  DocumentPromotionAttemptDto,
  ItemRecordDto,
  JsonValue,
  PlanningDocumentMetadataDto,
  ProjectRoleDto,
  TenboCommand,
} from '../contracts/tenbo';
import { CloudDashboardClient } from './client';
import { errorMessage } from './useCloudItems';
import styles from './CloudDashboard.module.css';

type SpecificationTab = 'summary' | 'read' | 'sections' | 'versions' | 'promotion';
type MarkdownBlock = { heading_path: string[]; markdown: string };
type StructuralDocument = {
  id: string;
  version: string;
  section_hash?: string;
  blocks: MarkdownBlock[];
  structural_bounds: { truncated: boolean; continuation_cursor?: string };
};

export function CloudItemSpecifications({
  client, projectId, record, role, ownsClaim, fencingToken, onRefresh,
}: {
  client: CloudDashboardClient;
  projectId: string;
  record: ItemRecordDto;
  role: ProjectRoleDto;
  ownsClaim: boolean;
  fencingToken?: number;
  onRefresh(): Promise<void>;
}) {
  const specifications = useMemo(() => attachedSpecifications(record), [record]);
  const active = specifications.find((document) => !document.archived);
  const [selectedId, setSelectedId] = useState(record.specification?.id ?? specifications[0]?.id ?? '');
  const selected = specifications.find((document) => document.id === selectedId) ?? active ?? specifications[0];
  const [tab, setTab] = useState<SpecificationTab>('summary');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullContext, setFullContext] = useState<StructuralDocument | null>(null);
  const [sectionHeading, setSectionHeading] = useState('');
  const [sectionContext, setSectionContext] = useState<StructuralDocument | null>(null);
  const [sectionBody, setSectionBody] = useState('');
  const [newHeading, setNewHeading] = useState('');
  const [newBody, setNewBody] = useState('');
  const [versions, setVersions] = useState<DocumentVersionDto[]>([]);
  const [fromVersion, setFromVersion] = useState('');
  const [toVersion, setToVersion] = useState('');
  const [diff, setDiff] = useState<Record<string, JsonValue> | null>(null);
  const [promotions, setPromotions] = useState<DocumentPromotionAttemptDto[]>([]);
  const [draft, setDraft] = useState(() => specificationTemplate(record));
  const canEdit = role !== 'viewer';
  const terminalItem = record.item.status === 'done' || record.item.status === 'dropped' || record.archived;
  const mutationReady = canEdit && ownsClaim && fencingToken !== undefined && !busy && !terminalItem;

  useEffect(() => {
    if (!selectedId || !specifications.some((document) => document.id === selectedId)) {
      setSelectedId(record.specification?.id ?? specifications[0]?.id ?? '');
    }
  }, [record.specification?.id, selectedId, specifications]);

  useEffect(() => {
    setFullContext(null);
    setSectionContext(null);
    setVersions([]);
    setDiff(null);
    setPromotions([]);
  }, [selected?.id]);

  const mutate = async (command: TenboCommand) => {
    setBusy(true);
    setError(null);
    try {
      const result = await client.command(projectId, command);
      if (result.kind === 'document') setSelectedId(result.value.id);
      await onRefresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const loadFull = async (cursor?: string) => {
    if (!active || selected?.id !== active.id) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.getItemContext(projectId, record.item.id, {
        documentMode: 'full', ...(cursor ? { continuationCursor: cursor } : {}),
      });
      const context = structuralDocument(result.payload);
      setFullContext((current) => cursor && current
        ? { ...context, blocks: [...current.blocks, ...context.blocks] }
        : context);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const loadSection = async () => {
    if (!active || selected?.id !== active.id || !sectionHeading.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.getItemContext(projectId, record.item.id, {
        documentMode: 'section', section: sectionHeading.trim(),
      });
      const context = structuralDocument(result.payload);
      setSectionContext(context);
      setSectionBody(bodyFromSection(context.blocks.map((block) => block.markdown).join('\n')));
    } catch (cause) {
      setSectionContext(null);
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const loadVersions = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.getDocumentVersions(projectId, selected.id);
      setVersions(result.versions);
      setToVersion(result.versions[0]?.version ?? '');
      setFromVersion(result.versions[1]?.version ?? result.versions[0]?.version ?? '');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const compare = async () => {
    if (!selected || !fromVersion || !toVersion) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.compareDocumentVersions(projectId, selected.id, fromVersion, toVersion);
      setDiff(isRecord(result) ? result : null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const loadPromotions = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.listDocumentPromotions(projectId, { documentId: selected.id });
      setPromotions(result.promotions);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.specWorkspace} aria-labelledby="item-specifications-title">
      <div className={styles.specHeader}>
        <div>
          <div className={styles.eyebrow}>Attached planning documents</div>
          <h3 id="item-specifications-title">Specification</h3>
        </div>
        {selected && <span className={styles.documentState}>{selected.archived ? 'Archived' : `Version ${selected.version}`}</span>}
      </div>

      {error && <div className={`${styles.stateBanner} ${styles.dangerBanner}`} role="alert">{error}<button className={styles.inlineButton} onClick={() => void onRefresh()}>Reload item</button></div>}
      {!ownsClaim && canEdit && !terminalItem && <p className={styles.specHint}>Claim the item lease to create or change its specification.</p>}
      {terminalItem && <p className={styles.specHint}>Completed or archived items keep specifications read-only until the item is reopened.</p>}

      {specifications.length > 0 && (
        <div className={styles.specPicker} aria-label="Attached specifications">
          {specifications.map((document) => (
            <button key={document.id} aria-pressed={selected?.id === document.id} onClick={() => setSelectedId(document.id)}>
              <span>{document.archived ? 'Archived' : 'Active'}</span>
              <strong>{document.path}</strong>
              <small>v{document.version} · {formatBytes(document.content_bytes)}</small>
            </button>
          ))}
        </div>
      )}

      {!active && canEdit && !terminalItem && (
        <div className={styles.specCreate}>
          <label>New specification<textarea rows={8} value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
          <button className={styles.primaryButton} disabled={!mutationReady || !draft.trim()} onClick={() => void mutate({
            kind: 'createPlanningDocument', item_id: record.item.id, document_kind: 'spec',
            slug: slugFromTitle(record.item.title), content: draft, fencing_token: fencingToken,
          })}><Plus size={14} />Create specification</button>
        </div>
      )}

      {selected && (
        <>
          <div className={styles.specTabs} role="tablist" aria-label="Specification tools">
            {([
              ['summary', 'Summary'], ['read', 'Read'], ['sections', 'Sections'], ['versions', 'Versions'], ['promotion', 'Promotion'],
            ] as const).map(([value, label]) => (
              <button key={value} role="tab" aria-selected={tab === value} onClick={() => {
                setTab(value);
                if (value === 'read' && !fullContext) void loadFull();
                if (value === 'versions' && versions.length === 0) void loadVersions();
                if (value === 'promotion' && promotions.length === 0) void loadPromotions();
              }}>{label}</button>
            ))}
          </div>

          <div className={styles.specPanel} role="tabpanel">
            {tab === 'summary' && <SpecificationSummary document={selected} />}

            {tab === 'read' && (
              selected.archived ? <p className={styles.muted}>Restore this specification before loading structural content.</p> :
                <div className={styles.structuralReader}>
                  {!fullContext && <p className={styles.muted}>{busy ? 'Loading bounded content…' : 'No content loaded.'}</p>}
                  {fullContext?.blocks.map((block, index) => <pre key={`${block.heading_path.join('/')}-${index}`}>{block.markdown}</pre>)}
                  {fullContext?.structural_bounds.continuation_cursor && <button className={styles.secondaryButton} disabled={busy} onClick={() => void loadFull(fullContext.structural_bounds.continuation_cursor)}>Load next bounded section</button>}
                </div>
            )}

            {tab === 'sections' && (
              selected.archived ? <p className={styles.muted}>Restore this specification before editing sections.</p> :
                <div className={styles.sectionTools}>
                  <form onSubmit={(event) => { event.preventDefault(); void loadSection(); }}>
                    <label>Existing heading<input value={sectionHeading} onChange={(event) => setSectionHeading(event.target.value)} placeholder="Implementation verification" /></label>
                    <button className={styles.secondaryButton} disabled={busy || !sectionHeading.trim()}>Load section</button>
                  </form>
                  {sectionContext && <div className={styles.sectionEditor}>
                    <label>Section body<textarea rows={10} value={sectionBody} onChange={(event) => setSectionBody(event.target.value)} /></label>
                    <button className={styles.primaryButton} disabled={!mutationReady || !sectionContext.section_hash} onClick={() => void mutate({
                      kind: 'replacePlanningDocumentSection', document_id: selected.id,
                      heading: sectionHeading.trim(), content: sectionBody,
                      expected_version: selected.version, expected_section_hash: sectionContext.section_hash ?? '',
                      fencing_token: fencingToken,
                    })}><Save size={14} />Save section</button>
                  </div>}
                  <div className={styles.sectionAppend}>
                    <h4>Add a section</h4>
                    <label>Heading<input value={newHeading} onChange={(event) => setNewHeading(event.target.value)} /></label>
                    <label>Body<textarea rows={5} value={newBody} onChange={(event) => setNewBody(event.target.value)} /></label>
                    <button className={styles.secondaryButton} disabled={!mutationReady || !newHeading.trim() || !newBody.trim()} onClick={() => void mutate({
                      kind: 'appendPlanningDocumentSection', document_id: selected.id,
                      heading: newHeading.trim(), content: newBody,
                      expected_version: selected.version, fencing_token: fencingToken,
                    })}><Plus size={14} />Add section</button>
                  </div>
                </div>
            )}

            {tab === 'versions' && <VersionHistory
              versions={versions} fromVersion={fromVersion} toVersion={toVersion} diff={diff}
              busy={busy} canRestore={mutationReady && !selected.archived}
              onFromVersion={setFromVersion} onToVersion={setToVersion} onCompare={() => void compare()}
              onRestore={(version) => void mutate({
                kind: 'restorePlanningDocumentVersion', document_id: selected.id, version,
                expected_version: selected.version, fencing_token: fencingToken,
              })}
            />}

            {tab === 'promotion' && <PromotionPanel
              document={selected}
              attempts={promotions}
              busy={busy}
              fencingToken={ownsClaim ? fencingToken : undefined}
              canAbandon={mutationReady}
              onRefresh={() => void loadPromotions()}
              onAbandon={(attempt) => void mutate({
                kind: 'abandonDocumentPromotion', attempt_id: attempt.id,
                expected_version: attempt.version, fencing_token: fencingToken!,
              }).then(() => void loadPromotions())}
            />}
          </div>

          {canEdit && !terminalItem && (
            <div className={styles.specActions}>
              {selected.archived ? (
                <button className={styles.secondaryButton} disabled={!mutationReady || (!!active && active.id !== selected.id)} onClick={() => void mutate({
                  kind: 'restorePlanningDocument', document_id: selected.id,
                  expected_version: selected.version, fencing_token: fencingToken,
                })}><RotateCcw size={14} />Restore specification</button>
              ) : (
                <button className={styles.secondaryButton} disabled={!mutationReady} onClick={() => void mutate({
                  kind: 'archivePlanningDocument', document_id: selected.id,
                  expected_version: selected.version, fencing_token: fencingToken,
                })}><Archive size={14} />Archive specification</button>
              )}
            </div>
          )}
        </>
      )}

      {specifications.length === 0 && !canEdit && <p className={styles.muted}>No specification is attached.</p>}
    </section>
  );
}

function SpecificationSummary({ document }: { document: PlanningDocumentMetadataDto }) {
  return <dl className={styles.specSummary}>
    <div><dt>Summary</dt><dd>{document.summary || 'No summary available.'}</dd></div>
    <div><dt>Document UUID</dt><dd><code>{document.id}</code></dd></div>
    <div><dt>Current hash</dt><dd><code>{document.content_hash}</code></dd></div>
    <div><dt>Size</dt><dd>{formatBytes(document.content_bytes)} · approximately {document.token_estimate.toLocaleString()} tokens</dd></div>
  </dl>;
}

function VersionHistory({
  versions, fromVersion, toVersion, diff, busy, canRestore,
  onFromVersion, onToVersion, onCompare, onRestore,
}: {
  versions: DocumentVersionDto[];
  fromVersion: string;
  toVersion: string;
  diff: Record<string, JsonValue> | null;
  busy: boolean;
  canRestore: boolean;
  onFromVersion(value: string): void;
  onToVersion(value: string): void;
  onCompare(): void;
  onRestore(version: string): void;
}) {
  if (versions.length === 0) return <p className={styles.muted}>{busy ? 'Loading version history…' : 'No versions found.'}</p>;
  return <div className={styles.versionTools}>
    <div className={styles.compareRow}>
      <label>From<select value={fromVersion} onChange={(event) => onFromVersion(event.target.value)}>{versions.map(option)}</select></label>
      <label>To<select value={toVersion} onChange={(event) => onToVersion(event.target.value)}>{versions.map(option)}</select></label>
      <button className={styles.secondaryButton} disabled={busy || !fromVersion || !toVersion} onClick={onCompare}>Compare</button>
    </div>
    {diff && <div className={styles.diffViewer} aria-label="Version comparison">
      <div><span>Removed</span><pre>{String(diff.removed ?? '')}</pre></div>
      <div><span>Added</span><pre>{String(diff.added ?? '')}</pre></div>
    </div>}
    <ol className={styles.versionList}>
      {versions.map((version, index) => <li key={version.version}>
        <FileClock size={14} />
        <div><strong>Version {version.version}</strong><span>{new Date(version.created_at).toLocaleString()} · {version.authored_by_type} {version.authored_by_id}</span></div>
        {index > 0 && <button className={styles.inlineButton} disabled={!canRestore || busy} onClick={() => onRestore(version.version)}>Restore</button>}
      </li>)}
    </ol>
  </div>;
}

function PromotionPanel({
  document, attempts, busy, fencingToken, canAbandon, onRefresh, onAbandon,
}: {
  document: PlanningDocumentMetadataDto;
  attempts: DocumentPromotionAttemptDto[];
  busy: boolean;
  fencingToken?: number;
  canAbandon: boolean;
  onRefresh(): void;
  onAbandon(attempt: DocumentPromotionAttemptDto): void;
}) {
  const open = attempts.find((attempt) => attempt.status === 'pending' || attempt.status === 'merged');
  return <div className={styles.promotionPanel}>
    <div className={styles.promotionIntro}>
      <p>Patch creation stays local. The cloud records this exact document version and finalizes only from committed Git bytes.</p>
      {!open && !document.archived && <code>npx tenbo-dashboard cloud promote-document --document {document.id} --target docs/spec.md{fencingToken ? ` --fencing-token ${fencingToken}` : ' --fencing-token <claim-fence>'}</code>}
    </div>
    <div className={styles.sectionHeading}><h4>Attempts</h4><button className={styles.inlineButton} disabled={busy} onClick={onRefresh}>Refresh</button></div>
    {attempts.length === 0 ? <p className={styles.muted}>{busy ? 'Loading promotion state…' : 'No promotion attempts.'}</p> : <ol className={styles.promotionList}>
      {attempts.map((attempt) => <li key={attempt.id}>
        <div><strong>{attempt.status}</strong><span>Source v{attempt.source_version} · {attempt.target_path}</span><small>{new Date(attempt.updated_at).toLocaleString()}</small></div>
        {(attempt.status === 'pending' || attempt.status === 'merged') && <button className={styles.inlineButton} disabled={!canAbandon || busy} onClick={() => onAbandon(attempt)}>Abandon</button>}
      </li>)}
    </ol>}
  </div>;
}

function option(version: DocumentVersionDto) {
  return <option key={version.version} value={version.version}>Version {version.version}</option>;
}

function attachedSpecifications(record: ItemRecordDto): PlanningDocumentMetadataDto[] {
  if (record.specifications) return record.specifications;
  return record.specification ? [record.specification] : [];
}

function structuralDocument(payload: JsonValue): StructuralDocument {
  if (!isRecord(payload) || !isRecord(payload.specification)) throw new Error('Tenbo returned no structural specification context.');
  const value = payload.specification;
  if (!Array.isArray(value.blocks) || !isRecord(value.structural_bounds)) throw new Error('Tenbo returned malformed structural specification context.');
  return value as unknown as StructuralDocument;
}

function bodyFromSection(markdown: string): string {
  return markdown.replace(/^#{1,6}\s+.*?(?:\r?\n){1,2}/, '');
}

function specificationTemplate(record: ItemRecordDto): string {
  return `# ${record.item.title}\n\n## Outcome\n\n${record.item.description ?? ''}\n\n## Acceptance criteria\n\n- `;
}

function slugFromTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

function formatBytes(value: number): string {
  return value < 1_024 ? `${value} B` : `${(value / 1_024).toFixed(1)} KB`;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
