import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LocalTenboBackend } from '../src/api/backends/LocalTenboBackend';
import { createCloudBackend } from '../src/cloud/createCloudBackend';
import { loadCloudConfig } from '../src/cloud/cloudConfig';
import {
  dirtyGitDocumentOverlay,
  ingestExactCommitGitDocument,
  readExactCommitGitDocument,
  rollbackDocumentPromotionPatch,
  writeDocumentPromotionPatch,
} from '../src/cloud/trustedGitDocuments';
import {
  TENBO_BACKEND_EPOCH,
  TENBO_CLIENT_VERSION,
  TENBO_SCHEMA_VERSION,
  type ActorDto,
  type DocumentPromotionAttemptDto,
  type TenboCommand,
  type TenboQuery,
} from '../src/contracts/tenbo';
import { buildCloudRoadmapManifest, assertCloudRoadmapManifest } from '../src/migration/cloudRoadmapManifest';
import { cloudRoadmapImportIdentity, CloudMigrationService, type CloudRecoveryExport } from '../src/migration/cloudMigrationService';
import { runBenchmarkProbe, runCloudBenchmark, type BenchmarkDurations } from '../src/cloud/cloudBenchmark';
import { hasFlag, positionalArgs, readOption } from './cliArgs';
import { handleCliError, isMain, misuse, repoRootFromCwd, runMain, serialize, type CliResult } from './cliResult';

const VALUE_FLAGS = ['--output', '--manifest', '--input', '--confirm-project', '--kind', '--item', '--query', '--commit', '--path', '--fixture', '--document', '--target', '--fencing-token', '--attempt'];

export async function runCloudCli(repoRoot: string, args: string[]): Promise<CliResult> {
  const json = hasFlag(args, '--json');
  const [command] = positionalArgs(args, { valueFlags: VALUE_FLAGS });
  if (!command || hasFlag(args, '--help')) return serialize({ ok: true, help: helpText() }, json, helpText());
  try {
    if (command === 'manifest') {
      const manifest = buildCloudRoadmapManifest(repoRoot);
      writeJsonOption(repoRoot, readOption(args, '--output'), manifest);
      return serialize({ ok: true, manifest, output: readOption(args, '--output') }, json, `${manifest.canonical_hash} ${manifest.counts.items} items\n`);
    }

    const config = loadCloudConfig({ repoRoot });
    if (!config) throw new Error('Tenbo cloud configuration is required');
    const backend = createCloudBackend(config);
    const actor: ActorDto = { id: process.env.TENBO_AGENT?.trim() || 'tenbo-cli', type: config.credential.type === 'human' ? 'user' : 'agent' };
    const service = new CloudMigrationService(backend, config.projectId, actor);

    if (command === 'benchmark' || command === 'benchmark-probe') {
      const fixturePath = readOption(args, '--fixture');
      if (!fixturePath) return misuse(`cloud ${command} requires --fixture <benchmark.json>`, json);
      const fixture = readJson(repoRoot, fixturePath);
      if (command === 'benchmark-probe') {
        const started = performance.now();
        const result = await runBenchmarkProbe(backend, fixture);
        return serialize({ ok: true, ...result.durations, process_wall_ms: round(performance.now() - started) }, true, '');
      }
      const absoluteFixture = path.resolve(repoRoot, fixturePath);
      const report = await runCloudBenchmark(backend, fixture, async () => coldProcessProbe(absoluteFixture));
      const result = serialize(report, json,
        `${report.ok ? 'passed' : 'failed'} cloud benchmark: brief ${report.warm_p95_ms.item_brief_ms}ms, items ${report.warm_p95_ms.filtered_items_ms}ms, context ${report.warm_p95_ms.feature_context_ms}ms\n`);
      return report.ok ? result : { ...result, exitCode: 1 };
    }

    if (command === 'import') {
      const manifestPath = readOption(args, '--manifest');
      const manifest = manifestPath ? readJson(repoRoot, manifestPath) : buildCloudRoadmapManifest(repoRoot);
      assertCloudRoadmapManifest(manifest);
      const replace = hasFlag(args, '--replace');
      const result = await service.importManifest(manifest, { replace });
      const import_identity = cloudRoadmapImportIdentity(config.projectId, manifest.canonical_hash, replace);
      return serialize({ ok: true, manifest_hash: manifest.canonical_hash, import_identity, result }, json,
        `imported ${manifest.counts.items} items (${manifest.canonical_hash}) [${import_identity.mode} ${import_identity.session_id}]\n`);
    }
    if (command === 'compare') {
      const manifestPath = readOption(args, '--manifest');
      const manifest = manifestPath ? readJson(repoRoot, manifestPath) : buildCloudRoadmapManifest(repoRoot);
      assertCloudRoadmapManifest(manifest);
      const comparison = await service.compare(manifest);
      const result = serialize({ ok: comparison.equal, comparison }, json, `${comparison.equal ? 'equal' : 'different'} ${comparison.local_hash} ${comparison.cloud_hash}\n`);
      return comparison.equal ? result : { ...result, exitCode: 1 };
    }
    if (command === 'export') {
      const recovery = await service.recoveryExport();
      writeJsonOption(repoRoot, readOption(args, '--output'), recovery);
      return serialize({ ok: true, recovery, output: readOption(args, '--output') }, json, `${recovery.canonical_hash}\n`);
    }
    if (command === 'restore') {
      const input = readOption(args, '--input');
      const confirmation = readOption(args, '--confirm-project');
      if (!input || !confirmation) return misuse('cloud restore requires --input <recovery.json> --confirm-project <uuid>', json);
      const recovery = readJson(repoRoot, input) as unknown as CloudRecoveryExport;
      const result = await service.restore(recovery, confirmation);
      return serialize({ ok: true, recovery_hash: recovery.canonical_hash, result }, json, `restored ${recovery.canonical_hash}\n`);
    }
    if (command === 'shadow-read') {
      const query = shadowQuery(args);
      const comparison = await service.shadowRead(new LocalTenboBackend(repoRoot), query);
      const result = serialize({ ok: comparison.equal, comparison }, json, `${comparison.equal ? 'equal' : 'different'} ${comparison.local_hash} ${comparison.cloud_hash}\n`);
      return comparison.equal ? result : { ...result, exitCode: 1 };
    }
    if (command === 'ingest-git') {
      const commit = readOption(args, '--commit');
      const documentPath = readOption(args, '--path');
      if (!commit || !documentPath) return misuse('cloud ingest-git requires --commit <full-sha> --path <repo-relative-path>', json);
      const document = await ingestExactCommitGitDocument(backend.ports, repoRoot, commit, documentPath, actor);
      return serialize({ ok: true, document }, json, `${document.commit_sha}:${document.path} ${document.content_hash}\n`);
    }
    if (command === 'promote-document') {
      const documentId = readOption(args, '--document');
      const target = readOption(args, '--target');
      const fencingToken = positiveIntegerOption(args, '--fencing-token');
      if (!documentId || !target || fencingToken === undefined) {
        return misuse('cloud promote-document requires --document <uuid> --target <repo-relative-path> --fencing-token <number>', json);
      }
      const patch = await writeDocumentPromotionPatch(backend.ports, repoRoot, documentId, target);
      try {
        const result = await cloudCommand(backend, config.projectId, actor, {
          kind: 'beginDocumentPromotion', document_id: patch.document_id,
          expected_version: patch.source_version, source_content_hash: patch.source_content_hash,
          target_repository: patch.target_repository, target_path: patch.target_path,
          fencing_token: fencingToken,
        });
        if (result.kind !== 'promotion') throw new Error(`expected promotion result, received ${result.kind}`);
        return serialize({ ok: true, promotion: result.value, patch: patch.target_path }, json,
          `created ${patch.target_path} and promotion ${result.value.id} from v${patch.source_version}\n`);
      } catch (cause) {
        rollbackDocumentPromotionPatch(repoRoot, patch);
        throw cause;
      }
    }
    if (command === 'promotions') {
      const result = await backend.query({
        schema_version: TENBO_SCHEMA_VERSION, client_version: TENBO_CLIENT_VERSION,
        backend_epoch: TENBO_BACKEND_EPOCH, project_id: config.projectId,
        query: {
          kind: 'listDocumentPromotions',
          ...(readOption(args, '--item') ? { item_id: readOption(args, '--item') } : {}),
          ...(readOption(args, '--document') ? { document_id: readOption(args, '--document') } : {}),
          ...(readOption(args, '--attempt') ? { attempt_id: readOption(args, '--attempt') } : {}),
          page: { limit: 100 },
        },
      });
      if (result.kind !== 'promotionPage') throw new Error(`expected promotionPage, received ${result.kind}`);
      return serialize({ ok: true, promotions: result.value, page: result.page }, json,
        result.value.map((attempt) => `${attempt.id} ${attempt.status} ${attempt.target_path}`).join('\n') + (result.value.length ? '\n' : ''));
    }
    if (command === 'abandon-promotion') {
      const attemptId = readOption(args, '--attempt');
      const fencingToken = positiveIntegerOption(args, '--fencing-token');
      if (!attemptId || fencingToken === undefined) return misuse('cloud abandon-promotion requires --attempt <uuid> --fencing-token <number>', json);
      const attempt = await promotionAttempt(backend, config.projectId, attemptId);
      const result = await cloudCommand(backend, config.projectId, actor, {
        kind: 'abandonDocumentPromotion', attempt_id: attempt.id,
        expected_version: attempt.version, fencing_token: fencingToken,
      });
      if (result.kind !== 'promotion') throw new Error(`expected promotion result, received ${result.kind}`);
      return serialize({ ok: true, promotion: result.value }, json, `abandoned promotion ${result.value.id}\n`);
    }
    if (command === 'finalize-promotion') {
      const attemptId = readOption(args, '--attempt');
      const commit = readOption(args, '--commit');
      if (!attemptId || !commit) return misuse('cloud finalize-promotion requires --attempt <uuid> --commit <full-sha>', json);
      const attempt = await promotionAttempt(backend, config.projectId, attemptId);
      const document = readExactCommitGitDocument(repoRoot, commit, attempt.target_path, attempt.target_repository);
      const result = await cloudCommand(backend, config.projectId, actor, {
        kind: 'finalizeDocumentPromotion', attempt_id: attempt.id, ...document,
      });
      if (result.kind !== 'promotion' && result.kind !== 'promotionRejected') {
        throw new Error(`expected promotion result, received ${result.kind}`);
      }
      const ok = result.kind === 'promotion';
      return {
        ...serialize({ ok, result }, json, ok
          ? `finalized promotion ${result.value.id} at ${document.commit_sha}\n`
          : `rejected promotion ${result.value.id}: ${result.reason}\n`),
        ...(ok ? {} : { exitCode: 1 }),
      };
    }
    if (command === 'dirty-overlay') {
      const commit = readOption(args, '--commit');
      const documentPath = readOption(args, '--path');
      if (!commit || !documentPath) return misuse('cloud dirty-overlay requires --commit <full-sha> --path <repo-relative-path>', json);
      const exported = await backend.ports.project.exportProject();
      const repository = exported && typeof exported === 'object' && !Array.isArray(exported)
        && exported.project && typeof exported.project === 'object' && !Array.isArray(exported.project)
        && typeof exported.project.repository === 'string' ? exported.project.repository : undefined;
      const overlay = dirtyGitDocumentOverlay(repoRoot, commit, documentPath, repository);
      return serialize({ ok: true, overlay }, json, overlay ? `${overlay.path} dirty overlay ${overlay.content_hash} (not persisted)\n` : `${documentPath} clean\n`);
    }
    return misuse(`unknown cloud command: ${command}`, json);
  } catch (error) {
    return handleCliError(error, json);
  }
}

function shadowQuery(args: string[]): TenboQuery {
  const kind = readOption(args, '--kind') ?? 'session';
  if (kind === 'session') return { kind: 'getSessionContext' };
  if (kind === 'item') {
    const item = readOption(args, '--item');
    if (!item) throw new Error('shadow-read --kind item requires --item <id>');
    return { kind: 'getItemContext', item_id: item };
  }
  if (kind === 'feature') {
    const query = readOption(args, '--query');
    if (!query) throw new Error('shadow-read --kind feature requires --query <text>');
    return { kind: 'searchContext', query };
  }
  if (kind === 'items') return { kind: 'listItems', page: { limit: 100 } };
  if (kind === 'queue') return { kind: 'getWorkQueue', page: { limit: 100 } };
  throw new Error('--kind must be session, item, feature, items, or queue');
}

function readJson(repoRoot: string, value: string): unknown {
  return JSON.parse(readFileSync(path.resolve(repoRoot, value), 'utf8'));
}

function writeJsonOption(repoRoot: string, value: string | undefined, payload: unknown): void {
  if (value) writeFileSync(path.resolve(repoRoot, value), `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

function coldProcessProbe(fixturePath: string): BenchmarkDurations & { process_wall_ms: number } {
  const started = performance.now();
  const child = spawnSync(process.execPath, [
    ...process.execArgv,
    fileURLToPath(import.meta.url),
    'benchmark-probe', '--fixture', fixturePath, '--json',
  ], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.status !== 0) throw new Error(`cold benchmark process failed: ${(child.stderr || child.stdout).trim()}`);
  const value = JSON.parse(child.stdout) as BenchmarkDurations & { process_wall_ms: number };
  return { ...value, process_wall_ms: round(performance.now() - started) };
}

function round(value: number): number { return Math.round(value * 100) / 100; }

async function cloudCommand(
  backend: ReturnType<typeof createCloudBackend>,
  projectId: string,
  actor: ActorDto,
  command: TenboCommand,
) {
  return backend.command({
    schema_version: TENBO_SCHEMA_VERSION,
    client_version: TENBO_CLIENT_VERSION,
    backend_epoch: TENBO_BACKEND_EPOCH,
    project_id: projectId,
    mutation_id: randomUUID(),
    actor,
    command,
  });
}

async function promotionAttempt(
  backend: ReturnType<typeof createCloudBackend>,
  projectId: string,
  attemptId: string,
): Promise<DocumentPromotionAttemptDto> {
  const result = await backend.query({
    schema_version: TENBO_SCHEMA_VERSION, client_version: TENBO_CLIENT_VERSION,
    backend_epoch: TENBO_BACKEND_EPOCH, project_id: projectId,
    query: { kind: 'listDocumentPromotions', attempt_id: attemptId, page: { limit: 1 } },
  });
  if (result.kind !== 'promotionPage' || result.value.length !== 1) throw new Error(`promotion attempt not found: ${attemptId}`);
  return result.value[0]!;
}

function positiveIntegerOption(args: string[], flag: string): number | undefined {
  const value = readOption(args, flag);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function helpText(): string {
  return `tenbo-dashboard cloud <command>

Commands:
  manifest [--output <file>]                  Build deterministic local migration manifest
  import [--manifest <file>] [--replace]      Import local state; --replace is exact cutover mode (admin)
  compare [--manifest <file>]                 Compare all cloud/local projections
  shadow-read --kind <session|item|feature|items|queue> [--item <id>|--query <text>]
  export [--output <file>]                    Create deterministic recovery export
  restore --input <file> --confirm-project <uuid>  Atomically replace from verified recovery
  ingest-git --commit <full-sha> --path <path>     Ingest bytes read only via exact git show
  promote-document --document <uuid> --target <path> --fencing-token <n>
                                                Create a reviewable patch and record exact source
  promotions [--item <id>|--document <uuid>|--attempt <uuid>]
                                                List promotion attempts and canonical state
  abandon-promotion --attempt <uuid> --fencing-token <n>
                                                Abandon an open promotion without changing the source
  finalize-promotion --attempt <uuid> --commit <full-sha>
                                                Admin finalization from exact committed Git bytes
  dirty-overlay --commit <full-sha> --path <path>  Show local-only dirty overlay; never persist
  benchmark --fixture <file>                   Run pinned 3+30 warm / 5 cold-process p95 gates
`;
}

if (isMain(import.meta.url)) runMain(await runCloudCli(repoRootFromCwd(), process.argv.slice(2)));
