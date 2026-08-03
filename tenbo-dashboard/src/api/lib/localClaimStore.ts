import type { ItemClaimDto } from '../../contracts/tenbo';
import { TenboContractError } from '../../contracts/tenbo';
import { readGeneratedCacheFile, writeGeneratedCacheFile } from './tenboFs';
import { findItem } from './roadmapStore';

interface ClaimState {
  claims: Record<string, ItemClaimDto>;
  next_fencing_tokens: Record<string, number>;
}

const CLAIM_PATH = ['coordination', 'claims.json'];
const DEFAULT_LEASE_SECONDS = 900;
const MAX_LEASE_SECONDS = 86_400;

function readState(repoRoot: string): ClaimState {
  const raw = readGeneratedCacheFile(repoRoot, CLAIM_PATH);
  if (!raw) return { claims: {}, next_fencing_tokens: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<ClaimState>;
    return {
      claims: parsed.claims ?? {},
      next_fencing_tokens: parsed.next_fencing_tokens ?? {},
    };
  } catch {
    return { claims: {}, next_fencing_tokens: {} };
  }
}

export function getActiveLocalClaim(repoRoot: string, itemId: string, now = new Date()): ItemClaimDto | null {
  const claim = readState(repoRoot).claims[itemId];
  return claim && new Date(claim.expires_at).getTime() > now.getTime() ? claim : null;
}

export function assertLocalClaimFence(repoRoot: string, itemId: string, fencingToken: number | undefined): void {
  const claim = getActiveLocalClaim(repoRoot, itemId);
  if (!claim) return;
  if (fencingToken !== claim.fencing_token) {
    throw new TenboContractError('conflict', `active claim for ${itemId} requires fencing token ${claim.fencing_token}`);
  }
}

function writeState(repoRoot: string, state: ClaimState): void {
  writeGeneratedCacheFile(repoRoot, CLAIM_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function leaseSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LEASE_SECONDS;
  if (!Number.isFinite(value) || value <= 0) throw new TenboContractError('invalid_request', 'lease_seconds must be positive');
  return Math.min(MAX_LEASE_SECONDS, Math.floor(value));
}

function expiresAt(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

export function claimLocalItem(
  repoRoot: string,
  itemId: string,
  owner: string,
  requestedLeaseSeconds?: number,
  now = new Date(),
): ItemClaimDto {
  findItem(repoRoot, itemId);
  const state = readState(repoRoot);
  const current = state.claims[itemId];
  const active = current && new Date(current.expires_at).getTime() > now.getTime();
  if (active && current.owner !== owner) {
    throw new TenboContractError('conflict', `item ${itemId} is claimed by ${current.owner} until ${current.expires_at}`);
  }
  const lease = leaseSeconds(requestedLeaseSeconds);
  if (active && current.owner === owner) {
    const renewed = { ...current, version: current.version + 1, expires_at: expiresAt(now, lease) };
    state.claims[itemId] = renewed;
    writeState(repoRoot, state);
    return renewed;
  }
  const fencingToken = (state.next_fencing_tokens[itemId] ?? 0) + 1;
  state.next_fencing_tokens[itemId] = fencingToken;
  const claim: ItemClaimDto = {
    item_id: itemId,
    owner,
    fencing_token: fencingToken,
    version: 1,
    expires_at: expiresAt(now, lease),
  };
  state.claims[itemId] = claim;
  writeState(repoRoot, state);
  return claim;
}

export function renewLocalClaim(
  repoRoot: string,
  itemId: string,
  owner: string,
  fencingToken: number,
  requestedLeaseSeconds?: number,
  now = new Date(),
): ItemClaimDto {
  const state = readState(repoRoot);
  const current = state.claims[itemId];
  if (!current || current.owner !== owner || current.fencing_token !== fencingToken) {
    throw new TenboContractError('conflict', `claim for ${itemId} is stale or owned by another actor`);
  }
  if (new Date(current.expires_at).getTime() <= now.getTime()) {
    throw new TenboContractError('conflict', `claim for ${itemId} has expired`);
  }
  const renewed = {
    ...current,
    version: current.version + 1,
    expires_at: expiresAt(now, leaseSeconds(requestedLeaseSeconds)),
  };
  state.claims[itemId] = renewed;
  writeState(repoRoot, state);
  return renewed;
}

export function releaseLocalClaim(repoRoot: string, itemId: string, owner: string, fencingToken: number): void {
  const state = readState(repoRoot);
  const current = state.claims[itemId];
  if (!current || current.owner !== owner || current.fencing_token !== fencingToken) {
    throw new TenboContractError('conflict', `claim for ${itemId} is stale or owned by another actor`);
  }
  delete state.claims[itemId];
  writeState(repoRoot, state);
}
