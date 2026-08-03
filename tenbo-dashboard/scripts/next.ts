import { listNextItems } from '../src/api/lib/roadmapStore';
import { summarizeItem } from '../src/api/lib/itemProjection';
import { hasFlag } from './cliArgs';
import { handleCliError, isMain, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';
import { loadCloudConfig } from '../src/cloud/cloudConfig';
import { CliTenboClient } from '../src/clients/CliTenboClient';
import { fetchAllCloudItems } from '../src/clients/cliCloudQueries';
import { comparePriority } from '../src/api/lib/priority';

export function runNextCli(repoRoot: string, args: string[]): CliResult {
  const cloud = loadCloudConfig({ repoRoot, optional: true });
  if (cloud) return runCloudNextCli(repoRoot, args, cloud) as unknown as CliResult;
  return renderNext(listNextItems(repoRoot), args);
}

function renderNext(items: ReturnType<typeof listNextItems>, args: string[]): CliResult {
  const json = hasFlag(args, '--json');
  const agentSummary = hasFlag(args, '--agent-summary');
  try {
    if (agentSummary) {
      const projected = items.map((entry) => summarizeItem(entry));
      return serialize({
        ok: true,
        recommended_sequence: projected.map((item) => item.id),
        items: projected,
        verification: projected.map((item) => ({
          id: item.id,
          commands: [
            `tenbo-dashboard item brief ${item.id} --json`,
            `tenbo-dashboard item verify ${item.id} --check --json`,
          ],
        })),
      }, json, `${projected.map((entry) => `${entry.id} ${entry.status} ${entry.title}`).join('\n')}${projected.length ? '\n' : ''}`);
    }
    return serialize({ ok: true, items }, json, `${items.map((entry) => `${entry.item.id} ${entry.item.status} ${entry.item.title}`).join('\n')}${items.length ? '\n' : ''}`);
  } catch (err) {
    return handleCliError(err, json);
  }
}

async function runCloudNextCli(repoRoot: string, args: string[], cloud: NonNullable<ReturnType<typeof loadCloudConfig>>): Promise<CliResult> {
  try {
    const items = await fetchAllCloudItems(new CliTenboClient(repoRoot, { cloudConfig: cloud }), 'getWorkQueue');
    items.sort((a, b) => (a.item.status === b.item.status ? 0 : a.item.status === 'now' ? -1 : 1) || comparePriority(a.item, b.item));
    return renderNext(items, args);
  } catch (error) { return handleCliError(error, hasFlag(args, '--json')); }
}

if (isMain(import.meta.url)) {
  runMain(await runNextCli(repoRootFromCwd(), process.argv.slice(2)));
}
