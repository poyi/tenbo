import path from 'node:path';
import { findRepoRoot } from '../src/api/lib/repoRoot';

export {
  allocateNextId,
  collectExistingNumbers,
  resolveRoadmapPaths,
  STALE_LOCK_MS,
  type AllocateOptions,
} from '../src/api/lib/idAllocator';
import { allocateNextId } from '../src/api/lib/idAllocator';
import { loadCloudConfig } from '../src/cloud/cloudConfig';
import { CliTenboClient } from '../src/clients/CliTenboClient';

function isMain(): boolean {
  try {
    const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const here = path.resolve(new URL(import.meta.url).pathname);
    return invoked === here;
  } catch {
    return false;
  }
}

export async function runNextIdCli(repoRoot: string, prefix: string): Promise<string> {
  const cloud = loadCloudConfig({ repoRoot, optional: true });
  if (cloud) {
    const result = await new CliTenboClient(repoRoot, { cloudConfig: cloud }).command(
      { kind: 'allocateItemId', prefix }, { id: process.env.TENBO_AGENT?.trim() || 'tenbo-cli', type: 'agent' },
    );
    if (result.kind !== 'allocation') throw new Error(`expected allocation, received ${result.kind}`);
    return result.item_id;
  }
  return allocateNextId({ repoRoot, prefix });
}

if (isMain()) {
  const prefix = process.argv[2];
  if (!prefix) {
    console.error('Usage: next-id <prefix>  (e.g. next-id ed)');
    process.exit(2);
  }
  try {
    const cwd = process.cwd();
    const repoRoot = findRepoRoot(cwd) ?? path.resolve(cwd, '..', '..');
    process.stdout.write(`${await runNextIdCli(repoRoot, prefix)}\n`);
    process.exit(0);
  } catch (err) {
    console.error(`next-id: ${(err as Error).message}`);
    process.exit(1);
  }
}
