import { toolArgumentsMatchSchema } from '../tools/tool-security.js';
import { validateConfiguredSafety } from './runtime-safety-policy.js';

function identity(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

export function evidenceBelongsToRuntime(source, scope) {
  if (!scope) return true;
  const revisions = new Map((scope.publicationRevisions ?? []).map((entry) => [
    identity(entry.knowledgeBaseId), Number(entry.publicationRevision ?? entry.revision),
  ]));
  return identity(source?.tenantId) === identity(scope.tenantId)
    && identity(source?.agentId) === identity(scope.agentId)
    && revisions.get(identity(source?.knowledgeBaseId)) === Number(source?.publicationRevision);
}

function workflowIdentifier(evidence) {
  const data = evidence?.authoritativeData ?? {};
  const config = data.actionConfig ?? {};
  return identity(config.toolIdentifier ?? config.actionKey);
}

function actionRequirementsSatisfied(evidence, runtime) {
  const config = evidence?.authoritativeData?.actionConfig ?? {};
  return config.requiresCatalogItem !== true || (runtime.knownEntities ?? []).length > 0;
}

export function workflowAuthorizesTool(name, runtime = {}) {
  const requested = identity(name);
  const current = (runtime.actionEvidence ?? []).some((evidence) => (
    evidence?.activationAllowed === true
    && String(evidence?.authoritativeData?.actionType ?? '').toLocaleLowerCase() === 'configured_tool'
    && workflowIdentifier(evidence) === requested
    && evidenceBelongsToRuntime(evidence, runtime.evidenceScope)
    && actionRequirementsSatisfied(evidence, runtime)
  ));
  if (current) return true;
  if (runtime.requireCurrentActionEvidence === true) return false;
  return Boolean(runtime.activeToolRequest?.authorizationRecordId
    && identity(runtime.activeToolRequest?.name) === requested);
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
    const tool = (runtime.toolSchemas ?? []).find((candidate) => candidate.name === toolRequest.name);
    if (!tool || !workflowAuthorizesTool(toolRequest.name, runtime)) {
      return Object.freeze({ valid: false, reason: 'unauthorized_tool_request' });
    }
    if (!toolArgumentsMatchSchema(toolRequest.arguments ?? {}, tool.inputSchema)) {
      return Object.freeze({ valid: false, reason: 'invalid_tool_arguments' });
    }
  }
  const safety = validateConfiguredSafety({
    answer: runtime.answer, toolRequest, policies: runtime.safetyPolicies,
  });
  if (!safety.valid) return safety;
  return Object.freeze({ valid: true });
}
