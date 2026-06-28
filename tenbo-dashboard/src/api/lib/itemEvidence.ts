import { findItem } from './roadmapStore';

export type ItemEvidenceVerdict = 'likely_done' | 'likely_open' | 'needs_review' | 'inconsistent';

export interface ItemEvidenceReport {
  ok: true;
  item_id: string;
  verdict: ItemEvidenceVerdict;
  status: string;
  missing: string[];
  signals: string[];
}

export function checkItemEvidence(repoRoot: string, itemId: string): ItemEvidenceReport {
  const located = findItem(repoRoot, itemId);
  const item = located.item;
  const missing: string[] = [];
  const signals: string[] = [];

  if (item.verification?.status) signals.push(`verification:${item.verification.status}`);
  if (item.doc_update) signals.push(`doc_update:${item.doc_update}`);
  if (item.links?.some((link) => link.startsWith('commit:'))) signals.push('commit_link');
  if (item.notes?.trim()) signals.push('notes');
  if (item.done_when?.length) signals.push(`done_when:${item.done_when.length}`);
  if (item.files_to_read?.length) signals.push(`files_to_read:${item.files_to_read.length}`);

  if (item.status === 'done') {
    if (!item.verification?.status) missing.push('verification');
    if (!item.doc_update) missing.push('doc_update');
    return {
      ok: true,
      item_id: item.id,
      verdict: missing.length > 0 ? 'inconsistent' : 'likely_done',
      status: item.status,
      missing,
      signals,
    };
  }

  const hasDoneEvidence = item.verification?.status === 'verified' || Boolean(item.doc_update);
  return {
    ok: true,
    item_id: item.id,
    verdict: hasDoneEvidence ? 'needs_review' : 'likely_open',
    status: item.status,
    missing,
    signals,
  };
}
