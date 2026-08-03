import { randomUUID } from 'node:crypto';
import {
  TENBO_SCHEMA_VERSION,
  TENBO_BACKEND_EPOCH,
  TENBO_CLIENT_VERSION,
  type ActorDto,
  type CommandEnvelopeDto,
  type ContextResultDto,
  type ItemPageDto,
  type ItemRecordDto,
  type ProjectPort,
  type TenboBackendPorts,
  type TenboCommandResult,
  type TenboCommand,
  TenboContractError,
  type TenboGatewayPort,
  type ContextQueryPort,
} from '../../contracts/tenbo';

/**
 * Server-side cloud backend skeleton. x-092 supplies the Edge gateway and
 * x-093 supplies its HTTP transport; this adapter already fixes the typed
 * port boundary and contains no IDS-specific table or Supabase assumption.
 */
export class CloudTenboBackend implements TenboGatewayPort {
  readonly ports: TenboBackendPorts;

  constructor(
    private readonly projectId: string,
    private readonly transport: TenboGatewayPort,
    private readonly mutationId: () => string = randomUUID,
    private readonly compatibility: { backendEpoch: number; clientVersion: string } = {
      backendEpoch: TENBO_BACKEND_EPOCH,
      clientVersion: TENBO_CLIENT_VERSION,
    },
  ) {
    const command = (value: TenboCommand, actor: ActorDto) =>
      this.command({ schema_version: TENBO_SCHEMA_VERSION, client_version: this.compatibility.clientVersion,
        backend_epoch: this.compatibility.backendEpoch, project_id: this.projectId, mutation_id: this.mutationId(), actor, command: value });
    const query = (value: Parameters<TenboGatewayPort['query']>[0]['query']) =>
      this.query({ schema_version: TENBO_SCHEMA_VERSION, client_version: this.compatibility.clientVersion,
        backend_epoch: this.compatibility.backendEpoch, project_id: this.projectId, query: value });

    this.ports = {
      items: {
        listItems: async (filters, page): Promise<ItemPageDto> => unwrapItemPage(await query({ kind: 'listItems', filters, page })),
        getItem: async (itemId, includeArchived): Promise<ItemRecordDto> => unwrapItem(await query({ kind: 'getItem', item_id: itemId, include_archived: includeArchived })),
        getWorkQueue: async (filters, page): Promise<ItemPageDto> => unwrapItemPage(await query({ kind: 'getWorkQueue', filters, page })),
        execute: command,
      },
      context: {
        session: async (): Promise<ContextResultDto> => unwrapContext(await query({ kind: 'getSessionContext' })),
        feature: async (text): Promise<ContextResultDto> => unwrapContext(await query({ kind: 'searchContext', query: text })),
        item: async (itemId): Promise<ContextResultDto> => unwrapContext(await query({ kind: 'getItemContext', item_id: itemId })),
      } satisfies ContextQueryPort,
      coordination: { execute: command },
      documents: {
        get: async (documentId) => {
          const result = await query({ kind: 'getDocument', document_id: documentId });
          if (result.kind !== 'document') throw new TenboContractError('invalid_request', `expected document, received ${result.kind}`);
          return result.value;
        },
        search: async (text, kind, page) => {
          const result = await query({ kind: 'searchDocuments', query: text, kind_filter: kind, page });
          if (result.kind !== 'documentPage') throw new TenboContractError('invalid_request', `expected documentPage, received ${result.kind}`);
          return { documents: result.value, page: result.page };
        },
        execute: command,
      },
      gitDocuments: { execute: command },
      project: {
        history: async (itemId, page) => {
          const result = await query({ kind: 'getMutationHistory', item_id: itemId, page });
          if (result.kind !== 'mutationHistory') throw new TenboContractError('invalid_request', `expected mutationHistory, received ${result.kind}`);
          return { entries: result.value, page: result.page };
        },
        exportProject: async () => {
          const result = await query({ kind: 'exportProject' });
          if (result.kind !== 'projectExport') throw new TenboContractError('invalid_request', `expected projectExport, received ${result.kind}`);
          return result.value;
        },
        importProject: async (manifest, actor, replace) => command({ kind: 'importProject', manifest, ...(replace ? { replace: true } : {}) }, actor),
        executeStagedImport: command,
      } satisfies ProjectPort,
    };
  }

  query(request: Parameters<TenboGatewayPort['query']>[0]) {
    return this.transport.query({ ...request, project_id: this.projectId });
  }

  command(request: CommandEnvelopeDto): Promise<TenboCommandResult> {
    return this.transport.command({ ...request, project_id: this.projectId });
  }
}

function unwrapItemPage(result: Awaited<ReturnType<TenboGatewayPort['query']>>): ItemPageDto {
  if (result.kind !== 'itemPage') throw new TenboContractError('invalid_request', `expected itemPage, received ${result.kind}`);
  return result.value;
}

function unwrapItem(result: Awaited<ReturnType<TenboGatewayPort['query']>>): ItemRecordDto {
  if (result.kind !== 'item') throw new TenboContractError('invalid_request', `expected item, received ${result.kind}`);
  return result.value;
}

function unwrapContext(result: Awaited<ReturnType<TenboGatewayPort['query']>>): ContextResultDto {
  if (result.kind !== 'context') throw new TenboContractError('invalid_request', `expected context, received ${result.kind}`);
  return result;
}
