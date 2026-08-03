import {
  type CommandEnvelopeDto,
  type QueryEnvelopeDto,
  type TenboBackendPorts,
  type TenboCommandResult,
  TenboContractError,
  type TenboQueryResult,
} from './tenbo';

export async function dispatchBackendQuery(backend: TenboBackendPorts, request: QueryEnvelopeDto): Promise<TenboQueryResult> {
  const query = request.query;
  switch (query.kind) {
    case 'listProjects':
    case 'getItemClaim':
    case 'listActiveClaims':
      throw new TenboContractError('unsupported', `${query.kind} is available only through the cloud gateway`);
    case 'listItems':
      return { kind: 'itemPage', value: await backend.items.listItems(query.filters, query.page) };
    case 'getItem':
      return { kind: 'item', value: await backend.items.getItem(query.item_id, query.include_archived) };
    case 'getWorkQueue':
      return { kind: 'itemPage', value: await backend.items.getWorkQueue(query.filters, query.page) };
    case 'getSessionContext':
      return backend.context.session();
    case 'searchContext':
      return backend.context.feature(query.query);
    case 'getItemContext':
      return backend.context.item(query.item_id);
    case 'getDocument':
      return { kind: 'document', value: await backend.documents.get(query.document_id) };
    case 'getDocumentVersions':
    case 'compareDocumentVersions':
    case 'listDocumentPromotions':
      throw new TenboContractError('unsupported', `${query.kind} is available only through the cloud gateway`);
    case 'searchDocuments': {
      const result = await backend.documents.search(query.query, query.kind_filter, query.page);
      return { kind: 'documentPage', value: result.documents, page: result.page };
    }
    case 'getMutationHistory': {
      const result = await backend.project.history(query.item_id, query.page);
      return { kind: 'mutationHistory', value: result.entries, page: result.page };
    }
    case 'exportProject':
      return { kind: 'projectExport', value: await backend.project.exportProject() };
    default:
      throw new TenboContractError('unsupported', `unsupported query: ${(query as { kind?: string }).kind ?? 'unknown'}`);
  }
}

export async function dispatchBackendCommand(backend: TenboBackendPorts, request: CommandEnvelopeDto): Promise<TenboCommandResult> {
  const command = request.command;
  switch (command.kind) {
    case 'claimItem':
    case 'renewClaim':
    case 'releaseClaim':
      return backend.coordination.execute(command, request.actor);
    case 'createPlanningDocument':
    case 'updatePlanningDocument':
    case 'replacePlanningDocumentSection':
    case 'appendPlanningDocumentSection':
    case 'restorePlanningDocumentVersion':
    case 'archivePlanningDocument':
    case 'restorePlanningDocument':
      return backend.documents.execute(command, request.actor);
    case 'ingestGitDocument':
      return backend.gitDocuments.execute(command, request.actor);
    case 'beginDocumentPromotion':
    case 'abandonDocumentPromotion':
    case 'finalizeDocumentPromotion':
      throw new TenboContractError('unsupported', `${command.kind} is available only through the cloud gateway`);
    case 'importProject':
      return backend.project.importProject(command.manifest, request.actor, command.replace);
    case 'beginProjectImport':
    case 'uploadProjectImportChunk':
    case 'finalizeProjectImport':
      return backend.project.executeStagedImport(command, request.actor);
    case 'allocateItemId':
    case 'createItem':
    case 'updateRichFields':
    case 'setStatus':
    case 'reorderItems':
    case 'archiveItem':
    case 'reopenItem':
    case 'addNote':
    case 'setVerification':
    case 'setDocUpdate':
    case 'linkCommit':
    case 'completeItem':
    case 'addDependency':
    case 'removeDependency':
      return backend.items.execute(command, request.actor);
    default:
      throw new TenboContractError('unsupported', `unsupported command: ${(command as { kind?: string }).kind ?? 'unknown'}`);
  }
}
