import { toolArgumentsMatchSchema } from '../tools/tool-security.js';
import { validateConfiguredSafety } from './runtime-safety-policy.js';

function identity(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

export function evidenceBelongsToRuntime(source, scope) {
  if (!scope) return true;
  if (String(source?.recordType ?? '').toLocaleUpperCase() === 'RUNTIME_CONFIG') {
    return identity(source?.tenantId) === identity(scope.tenantId)
      && identity(source?.agentId) === identity(scope.agentId)
      && source?.callerFacing === true
      && source?.authoritativeData?.verified === true
      && identity(source?.authoritativeData?.configurationType) === 'call check response';
  }
  if (String(source?.recordType ?? '').toLocaleUpperCase() === 'TOOL_RESULT') {
    return identity(source?.tenantId) === identity(scope.tenantId)
      && identity(source?.agentId) === identity(scope.agentId)
      && source?.authoritativeData?.verified === true
      && typeof source?.authoritativeData?.success === 'boolean';
  }
  const revisions = new Map((scope.publicationRevisions ?? []).map((entry) => [
    identity(entry.knowledgeBaseId), Number(entry.publicationRevision ?? entry.revision),
  ]));
  const identityValid = identity(source?.tenantId) === identity(scope.tenantId)
    && identity(source?.agentId) === identity(scope.agentId)
    && revisions.get(identity(source?.knowledgeBaseId)) === Number(source?.publicationRevision);
  if (!identityValid) return false;
  if (scope.requireHydratedEvidence !== true) return true;
  return source?.hydrationValidated === true
    && source?.documentStatus === 'ready'
    && source?.documentVersionStatus === 'ready'
    && source?.documentVersionIsCurrent === true
    && Boolean(source?.documentId) && Boolean(source?.documentVersionId);
}

function workflowIdentifier(evidence) {
  const data = evidence?.authoritativeData ?? {};
  const config = data.actionConfig ?? {};
  return identity(config.toolIdentifier ?? config.actionKey);
}

function toolIdentifiers(tool = {}) {
  return new Set([
    tool.id, tool.name, ...(tool.identifiers ?? []),
  ].map(identity).filter(Boolean));
}

function sameValue(left, right) {
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right);
  if (typeof left === 'boolean' || typeof right === 'boolean') return left === right;
  return identity(left) === identity(right);
}

function catalogIdentity(source) {
  const data = source?.authoritativeData ?? {};
  return new Set([
    source?.recordId, data.itemKey, data.name,
  ].map(identity).filter(Boolean));
}

function selectableCatalog(source) {
  return String(source?.recordType ?? '').toLocaleUpperCase() === 'CATALOG_ITEM'
    && source?.authoritativeData?.selectionRules?.selectable === true;
}

function exactCatalogItem(runtime = {}) {
  const active = runtime.activeToolRequest ?? {};
  if (active.selectedEntityKey && active.catalogRecordId) {
    return Object.freeze({
      key: active.selectedEntityKey, recordId: active.catalogRecordId,
      name: active.selectedEntityName ?? active.selectedEntityKey,
    });
  }
  const selected = runtime.selectedEntities ?? [];
  if (selected.length !== 1) return null;
  const requested = new Set([
    selected[0]?.id, selected[0]?.key, selected[0]?.name,
  ].map(identity).filter(Boolean));
  const matches = (runtime.catalogEvidence ?? []).filter((source) => (
    selectableCatalog(source)
    && [...catalogIdentity(source)].some((candidate) => requested.has(candidate))
  ));
  if (matches.length !== 1) return null;
  const source = matches[0];
  return Object.freeze({
    key: source.authoritativeData.itemKey,
    name: source.authoritativeData.name,
    recordId: source.recordId,
  });
}

function workflowAuthorization(tool, runtime = {}) {
  const identifiers = toolIdentifiers(tool);
  const evidence = (runtime.actionEvidence ?? []).find((candidate) => (
    candidate?.activationAllowed === true
    && String(candidate?.authoritativeData?.actionType ?? '').toLocaleLowerCase() === 'configured_tool'
    && identifiers.has(workflowIdentifier(candidate))
    && evidenceBelongsToRuntime(candidate, runtime.evidenceScope)
  ));
  if (evidence) return Object.freeze({
    recordId: evidence.recordId,
    requiresCatalogItem: evidence.authoritativeData?.actionConfig?.requiresCatalogItem === true,
  });
  if (runtime.requireCurrentActionEvidence !== true
    && runtime.activeToolRequest?.authorizationRecordId
    && identifiers.has(identity(runtime.activeToolRequest?.name))) {
    return Object.freeze({
      recordId: runtime.activeToolRequest.authorizationRecordId,
      requiresCatalogItem: Boolean(runtime.activeToolRequest.catalogRecordId),
    });
  }
  return null;
}

export function configuredToolAuthorization(name, runtime = {}) {
  const requested = identity(name);
  const tool = (runtime.toolSchemas ?? []).find((candidate) => toolIdentifiers(candidate).has(requested));
  if (!tool) return Object.freeze({ valid: false, reason: 'tool_not_assigned' });
  const authorization = workflowAuthorization(tool, runtime);
  if (!authorization) return Object.freeze({ valid: false, reason: 'workflow_authorization_missing' });
  const catalogItem = authorization.requiresCatalogItem ? exactCatalogItem(runtime) : null;
  if (authorization.requiresCatalogItem && !catalogItem) {
    return Object.freeze({ valid: false, reason: 'exact_selectable_catalog_item_required' });
  }
  return Object.freeze({
    valid: true, tool, authorizationRecordId: authorization.recordId, catalogItem,
  });
}

export function configuredActionActivation(runtime = {}) {
  const matches = (runtime.toolSchemas ?? []).flatMap((tool) => {
    const authorization = workflowAuthorization(tool, {
      ...runtime, requireCurrentActionEvidence: true,
    });
    return authorization ? [{ tool, authorization }] : [];
  });
  if (matches.length !== 1) return Object.freeze({ valid: false, reason: matches.length
    ? 'ambiguous_configured_action' : 'configured_action_not_activated' });
  const [{ tool, authorization }] = matches;
  return Object.freeze({
    valid: true,
    tool,
    authorizationRecordId: authorization.recordId,
    requiresCatalogItem: authorization.requiresCatalogItem,
  });
}

export function workflowAuthorizesTool(name, runtime = {}) {
  return configuredToolAuthorization(name, runtime).valid;
}

export function validateDecisionSecurity({ sources = [], toolRequest = null, runtime = {} } = {}) {
  for (const source of sources) {
    if (!evidenceBelongsToRuntime(source, runtime.evidenceScope)) {
      return Object.freeze({ valid: false, reason: 'foreign_evidence_selected' });
    }
    if (source.callerFacing === false) {
      return Object.freeze({ valid: false, reason: 'instruction_evidence_selected' });
    }
  }
  if (toolRequest) {
    const authorization = configuredToolAuthorization(toolRequest.name, runtime);
    if (!authorization.valid) return Object.freeze({
      valid: false, reason: authorization.reason === 'exact_selectable_catalog_item_required'
        ? authorization.reason : 'unauthorized_tool_request',
    });
    const tool = authorization.tool;
    if (!toolArgumentsMatchSchema(toolRequest.arguments ?? {}, tool.inputSchema)) {
      return Object.freeze({ valid: false, reason: 'invalid_tool_arguments' });
    }
    const collected = runtime.collectedInformation ?? {};
    for (const [key, value] of Object.entries(toolRequest.arguments ?? {})) {
      if ((runtime.configuredFieldKeys ?? []).includes(key) && !Object.hasOwn(collected, key)) {
        return Object.freeze({ valid: false, reason: 'tool_argument_not_collected' });
      }
      if (Object.hasOwn(collected, key) && !sameValue(collected[key], value)) {
        return Object.freeze({ valid: false, reason: 'tool_argument_not_collected' });
      }
    }
    if (runtime.confirmationRequired === true) {
      const active = runtime.activeToolRequest ?? {};
      if (active.status !== 'awaiting_confirmation'
        || identity(active.name) !== identity(toolRequest.name)) {
        return Object.freeze({
          valid: false, reason: 'confirmation_required', authorization,
        });
      }
    }
  }
  const safety = validateConfiguredSafety({
    answer: runtime.answer, toolRequest, policies: runtime.safetyPolicies,
  });
  if (!safety.valid) return safety;
  return Object.freeze({ valid: true });
}
