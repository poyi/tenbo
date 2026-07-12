/**
 * mutations.ts — the single dispatch table for every mutating item operation.
 *
 * `MutationRequest` is a plain-data description of one mutation ("set status
 * of ed-001 to done"). `applyMutation` runs it against `roadmapStore` exactly
 * as `scripts/item.ts` did before td-029. Both the direct-write fallback path
 * (the item entrypoint calling this in-process) and the hub route
 * (`routes/hubMutate.ts`, server-side, wrapped in `enqueueMutation`) call
 * this same function, so the two paths are byte-for-byte behaviorally
 * identical — routing through a hub changes only *where* `applyMutation`
 * runs, never what it does.
 *
 * td-030 adds two things to this choke point, both on EVERY request
 * regardless of path:
 *
 *   1. Attribution: `req.agent` (resolved once at the CLI boundary — see
 *      hub/identity.ts) is threaded into `addItemNote`/`setItemVerification`/
 *      `completeItem` so notes and verification evidence record who made
 *      them.
 *   2. Idempotency + journal: `req.mutationId` is also generated once at the
 *      CLI boundary and shared by BOTH the hub-apply attempt (over HTTP) and
 *      any direct-write fallback attempt of the SAME invocation. Before
 *      dispatching, `applyMutation` checks whether that mutation id is
 *      already journaled; if so, the mutation already landed on a prior
 *      attempt (e.g. the hub committed it but the HTTP response was lost),
 *      so this call is a no-op that returns the current state instead of
 *      double-applying. Otherwise the mutation is dispatched as normal and a
 *      journal event is appended on success.
 *
 * td-034 closes the residual gap in (2): the journal check above is only
 * reliable once the winning attempt's journal write is durably VISIBLE to
 * the losing attempt's check. If the hub applies + journals a mutation but
 * the HTTP response is lost before the CLI's fallback runs its own
 * `hasJournaledMutation` check, that check can still observe "not
 * journaled" and double-dispatch. `acquireMutationClaim` (mutationClaim.ts)
 * closes this with a cross-process, per-mutationId exclusive claim file —
 * see that module's doc comment for the full mechanism, staleness, and
 * fail-open rules. It runs for every mutation that gets past the journal
 * fast path, on both the hub route and the direct-write fallback, since
 * both go through this same function.
 */

import {
  addItemNote,
  completeItem,
  currentWriteResult,
  linkItemCommit,
  setItemDocUpdate,
  setItemStatus,
  setItemVerification,
  type WriteResult,
} from '../roadmapStore';
import { appendJournalEvent, hasJournaledMutation, type AppendJournalOptions } from './journal';
import { acquireMutationClaim, type MutationClaimOptions } from './mutationClaim';

export type MutationOp =
  | { op: 'set-status'; itemId: string; status: string }
  | { op: 'add-note'; itemId: string; note: string }
  | { op: 'verify'; itemId: string; status: string; evidence?: string[]; note?: string }
  | { op: 'doc-update'; itemId: string; docUpdate: string }
  | {
      op: 'complete';
      itemId: string;
      evidence: string[];
      docUpdate?: string;
      commit?: string;
      verificationStatus?: string;
    }
  | { op: 'link-commit'; itemId: string; commit: string };

export type MutationRequest = MutationOp & {
  /** Mutation id shared by the hub-apply and fallback-apply attempts of one CLI invocation (idempotency key). */
  mutationId: string;
  /** Resolved agent identity (see hub/identity.ts) attributing this mutation. */
  agent: string;
};

export interface ApplyMutationOptions {
  /** Injectable clock/pid/counter for the journal write — see journal.ts. Tests only; production uses real values. */
  journal?: AppendJournalOptions;
  /** Injectable options for the td-034 cross-process claim — see mutationClaim.ts. Tests only; production uses real values. */
  claim?: MutationClaimOptions;
  /**
   * Injectable override for the fast-path idempotency check (step 1 below).
   * Tests only — lets a test simulate "journal not yet durably visible"
   * for exactly this check without affecting the REAL `hasJournaledMutation`
   * the td-034 claim mechanism's poll loop uses, which is what proves the
   * claim (not journal timing) is what closes the race. Production always
   * uses the real `hasJournaledMutation`.
   */
  hasJournaledMutation?: (repoRoot: string, mutationId: string) => boolean;
}

function dispatchMutation(repoRoot: string, req: MutationRequest): WriteResult {
  switch (req.op) {
    case 'set-status':
      return setItemStatus(repoRoot, req.itemId, req.status);
    case 'add-note':
      return addItemNote(repoRoot, req.itemId, req.note, { actor: req.agent });
    case 'verify':
      return setItemVerification(repoRoot, req.itemId, {
        status: req.status,
        evidence: req.evidence,
        note: req.note,
        actor: req.agent,
      });
    case 'doc-update':
      return setItemDocUpdate(repoRoot, req.itemId, req.docUpdate);
    case 'complete':
      return completeItem(repoRoot, req.itemId, {
        evidence: req.evidence,
        docUpdate: req.docUpdate,
        commit: req.commit,
        verificationStatus: req.verificationStatus,
        actor: req.agent,
      });
    case 'link-commit':
      return linkItemCommit(repoRoot, req.itemId, req.commit);
  }
}

export function applyMutation(repoRoot: string, req: MutationRequest, opts: ApplyMutationOptions = {}): WriteResult {
  const checkJournaled = opts.hasJournaledMutation ?? hasJournaledMutation;
  if (checkJournaled(repoRoot, req.mutationId)) {
    // Already applied on a prior attempt (e.g. hub committed it but the HTTP
    // response was lost, and the CLI fell back and retried) — a no-op that
    // returns current state rather than double-applying the mutation.
    return currentWriteResult(repoRoot, req.itemId);
  }

  // td-034: cross-process claim closes the window where the check above can
  // be fooled by journal-write visibility lag (see mutationClaim.ts). If
  // another actor already owns/owned this exact mutationId and has since
  // journaled it, treat this call as the same kind of no-op as above.
  const claim = acquireMutationClaim(repoRoot, req.mutationId, opts.claim);
  if (!claim.shouldApply) {
    return currentWriteResult(repoRoot, req.itemId);
  }

  const result = dispatchMutation(repoRoot, req);

  // Journaling is best-effort and must NEVER fail an already-committed
  // mutation. If it threw here, the roadmap write above has already landed
  // on disk; propagating the error would make the hub route respond
  // {ok:false}, which would make the CLI fall back and re-apply the SAME
  // mutationId (see performMutation in scripts/item.ts) — but since the
  // journal entry never got written, `hasJournaledMutation` would still be
  // false on that retry, so the mutation would be applied TWICE (duplicate
  // note/evidence). See journal.ts's doc comment: the journal is an audit
  // aid, not an integrity-critical transaction log, so a gap in it is far
  // preferable to a duplicated mutation.
  try {
    appendJournalEvent(
      repoRoot,
      { mutationId: req.mutationId, actor: req.agent, itemId: req.itemId, operation: req.op },
      opts.journal,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`warning: failed to journal mutation ${req.mutationId} for ${req.itemId} — ${message}\n`);
  }

  return result;
}
