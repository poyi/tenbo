import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Clock3, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type {
  ItemClaimDto,
  ActiveClaimDto,
  ItemRecordDto,
  MutationHistoryEntryDto,
  ProjectRoleDto,
} from '../contracts/tenbo';
import type { Status } from '../types';
import { CloudDashboardClient } from './client';
import { errorMessage } from './useCloudItems';
import styles from './CloudDashboard.module.css';

const statuses: Status[] = ['now', 'next', 'later', 'done', 'dropped'];

export function CloudItemDialog({ client, projectId, initial, userId, role, onClose, onChanged }: {
  client: CloudDashboardClient;
  projectId: string;
  initial: ItemRecordDto;
  userId: string;
  role: ProjectRoleDto;
  onClose(): void;
  onChanged(record: ItemRecordDto): void;
}) {
  const [record, setRecord] = useState(initial);
  const [claim, setClaim] = useState<ItemClaimDto | null>(null);
  const [activeClaims, setActiveClaims] = useState<ActiveClaimDto[]>([]);
  const [claimsPartial, setClaimsPartial] = useState(false);
  const [history, setHistory] = useState<MutationHistoryEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [title, setTitle] = useState(initial.item.title);
  const [description, setDescription] = useState(initial.item.description ?? '');
  const [note, setNote] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const canEdit = role !== 'viewer';

  const refresh = async () => {
    setLoading(true);
    try {
      const [nextRecord, nextClaim, nextHistory, nextActiveClaims] = await Promise.all([
        client.getItem(projectId, record.item.id),
        client.getItemClaim(projectId, record.item.id),
        client.history(projectId, record.item.id),
        client.listActiveClaims(projectId),
      ]);
      setRecord(nextRecord);
      setTitle(nextRecord.item.title);
      setDescription(nextRecord.item.description ?? '');
      setClaim(nextClaim);
      setHistory(nextHistory.entries);
      setActiveClaims(nextActiveClaims.claims);
      setClaimsPartial(nextActiveClaims.page.has_more);
      setConflict(false);
      setError(null);
      onChanged(nextRecord);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && dialogRef.current) {
        const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.clearInterval(timer);
      previous?.focus();
    };
  }, [projectId, initial.item.id]);

  const run = async (command: Parameters<CloudDashboardClient['command']>[1]) => {
    setSaving(true);
    setError(null);
    try {
      const result = await client.command(projectId, command);
      if (result.kind === 'item') {
        setRecord(result.value);
        setTitle(result.value.item.title);
        setDescription(result.value.item.description ?? '');
        onChanged(result.value);
      } else if (result.kind === 'claim') setClaim(result.value);
      else if (result.kind === 'claimReleased') setClaim(null);
      setConflict(false);
      const nextHistory = await client.history(projectId, record.item.id);
      setHistory(nextHistory.entries);
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      setConflict(message.toLowerCase().includes('conflict'));
    } finally {
      setSaving(false);
    }
  };

  const claimExpired = claim ? new Date(claim.expires_at).getTime() <= Date.now() : false;
  const ownClaim = !!claim && claim.owner === userId && !claimExpired;
  const overlap = !!claim && claim.owner !== userId && !claimExpired;
  const fileOverlaps = advisoryFileOverlaps(record, activeClaims);

  return (
    <div className={styles.dialogBackdrop} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className={styles.itemDialog} role="dialog" aria-modal="true" aria-labelledby="cloud-item-title">
        <header className={styles.dialogHeader}>
          <div>
            <div className={styles.eyebrow}>{record.item.id} · version {record.version}</div>
            <h2 id="cloud-item-title">{record.item.title}</h2>
          </div>
          <button ref={closeRef} className={styles.iconButton} onClick={onClose} aria-label="Close item"><X size={18} /></button>
        </header>

        {loading && <div className={styles.stateBanner} role="status">Refreshing item, claim, and actor history…</div>}
        {overlap && (
          <div className={`${styles.stateBanner} ${styles.warningBanner}`} role="alert">
            <AlertTriangle size={16} /> Another session owns this lease: <code>{claim.owner}</code>, fence {claim.fencing_token}, until {formatTime(claim.expires_at)}. Coordinate before editing.
          </div>
        )}
        {claim && claimExpired && (
          <div className={`${styles.stateBanner} ${styles.warningBanner}`} role="status">
            <Clock3 size={16} /> The previous lease expired at {formatTime(claim.expires_at)}. Claim again before coordinated work.
          </div>
        )}
        {fileOverlaps.length > 0 && (
          <div className={`${styles.stateBanner} ${styles.advisoryBanner}`} role="status">
            <AlertTriangle size={16} />
            <div>
              <strong>Advisory overlap — not a lock.</strong> Active claimed work references the same files. The same-item fenced lease below remains authoritative.
              <ul>{fileOverlaps.map((warning) => <li key={warning.itemId}><code>{warning.itemId}</code> by {shortActor(warning.owner)} · {warning.files.join(', ')}</li>)}</ul>
              {claimsPartial && <span>Warning scan is bounded to the first 30 active claims.</span>}
            </div>
          </div>
        )}
        {conflict && (
          <div className={`${styles.stateBanner} ${styles.dangerBanner}`} role="alert">
            This item changed in another session. Your edit was not applied.
            <button className={styles.inlineButton} onClick={() => void refresh()}>Reload canonical item</button>
          </div>
        )}
        {error && !conflict && <div className={`${styles.stateBanner} ${styles.dangerBanner}`} role="alert">{error}</div>}

        <div className={styles.claimRow} aria-label="Authoritative same-item coordination lease">
          <ShieldCheck size={16} />
          <strong>Same-item lease</strong>
          {!claim || claimExpired ? (
            <><span>No active lease.</span>{canEdit && <button className={styles.secondaryButton} disabled={saving} onClick={() => void run({ kind: 'claimItem', item_id: record.item.id, owner: userId, lease_seconds: 300 })}>Claim for 5 minutes</button>}</>
          ) : ownClaim ? (
            <>
              <span>You own fence {claim.fencing_token} until {formatTime(claim.expires_at)}.</span>
              <button className={styles.secondaryButton} disabled={saving} onClick={() => void run({ kind: 'renewClaim', item_id: record.item.id, owner: userId, fencing_token: claim.fencing_token, lease_seconds: 300 })}>Renew</button>
              <button className={styles.secondaryButton} disabled={saving} onClick={() => void run({ kind: 'releaseClaim', item_id: record.item.id, owner: userId, fencing_token: claim.fencing_token })}>Release</button>
            </>
          ) : <span>Owned by {claim.owner}; fence {claim.fencing_token}.</span>}
        </div>

        <div className={styles.dialogGrid}>
          <div className={styles.editColumn}>
            <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} disabled={!canEdit || saving} /></label>
            <label>Description<textarea rows={8} value={description} onChange={(event) => setDescription(event.target.value)} disabled={!canEdit || saving} /></label>
            {canEdit && (
              <button className={styles.primaryButton} disabled={saving || !title.trim()} onClick={() => void run({ kind: 'updateRichFields', item_id: record.item.id, patch: { title: title.trim(), description }, expected_version: record.version })}>
                Save fields
              </button>
            )}
            <label>Status
              <select value={record.item.status} disabled={!canEdit || saving} onChange={(event) => void run({ kind: 'setStatus', item_id: record.item.id, status: event.target.value as Status, expected_version: record.version })}>
                {statuses.map((status) => <option key={status}>{status}</option>)}
              </select>
            </label>
            {canEdit && (
              <div className={styles.noteComposer}>
                <label>Add note<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></label>
                <button className={styles.secondaryButton} disabled={saving || !note.trim()} onClick={() => void run({ kind: 'addNote', item_id: record.item.id, note: note.trim(), expected_version: record.version }).then(() => setNote(''))}>Add note</button>
              </div>
            )}
          </div>
          <aside className={styles.historyColumn} aria-label="Item actor history">
            <div className={styles.sectionHeading}><h3>Actor history</h3><button className={styles.iconButton} onClick={() => void refresh()} aria-label="Refresh item"><RefreshCw size={14} /></button></div>
            {history.length === 0 ? <p className={styles.muted}>No recorded mutations.</p> : (
              <ol className={styles.historyList}>
                {history.map((entry) => (
                  <li key={entry.mutation_id}>
                    <strong>{entry.operation}</strong>
                    <span>{entry.actor_type ?? 'actor'} · {shortActor(entry.actor)}</span>
                    <time dateTime={entry.timestamp}>{formatTime(entry.timestamp)}</time>
                  </li>
                ))}
              </ol>
            )}
          </aside>
        </div>
      </section>
    </div>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function shortActor(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export function advisoryFileOverlaps(record: ItemRecordDto, claims: ActiveClaimDto[]) {
  const currentFiles = new Set((record.item.files_to_read ?? []).map(normalizedPath).filter(Boolean));
  if (currentFiles.size === 0) return [];
  return claims
    .filter((claim) => claim.item_id !== record.item.id)
    .map((claim) => ({
      itemId: claim.item_id,
      owner: claim.owner,
      files: claim.files_to_read.filter((path) => currentFiles.has(normalizedPath(path))).slice(0, 5),
    }))
    .filter((warning) => warning.files.length > 0);
}

function normalizedPath(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}
