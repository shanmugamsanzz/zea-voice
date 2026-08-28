import {
  createKnowledgeEngineDecision,
  knowledgeEngineDecisionTypes,
  knowledgeEngineResponseModes,
} from '../knowledge-engine/engine-contract.js';
import { validateGroundedClaims } from '../voice/interaction/grounded-claim-validator.js';

function clean(value, maximum = 1_500) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function identity(value) {
  return clean(value, 160).toLocaleLowerCase().replace(/[^a-z0-9._:-]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

function identifiers(tool = {}) {
  const configuration = object(tool.configuration);
  return new Set([
    tool.id, tool.name, configuration.identifier, configuration.toolIdentifier,
    configuration.actionKey, configuration.key, ...(tool.identifiers ?? []),
  ].map(identity).filter(Boolean));
}

function schema(tool = {}) {
  const configuration = object(tool.configuration);
  return object(tool.inputSchema ?? configuration.inputSchema ?? configuration.input_schema
    ?? configuration.parametersSchema ?? configuration.parameters_schema);
}

function technical(reason, evidenceIds = []) {
  return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.CLARIFY, {
    reason,
    evidenceIds,
    clarification: { kind: 'technical', prompt: null },
  });
}

function resultEvidence(input, result, configuredMessage) {
  let serialized = '';
  try { serialized = JSON.stringify(result.output ?? {}); } catch { /* non-serializable output is omitted */ }
  return Object.freeze({
    id: `tool-result:${result.toolId ?? result.name}:${input.callId}`,
    recordId: String(result.toolId ?? result.name),
    recordType: 'TOOL_RESULT',
    tenantId: input.tenantId,
    agentId: input.agentId,
    callerFacing: true,
    content: clean(`${configuredMessage} ${serialized}`, 8_000),
    authoritativeData: Object.freeze({
      verified: true,
      success: true,
      output: result.output,
    }),
  });
}

function validateVerifiedToolSpeech({ input, answer, selectedEvidenceIds, evidence }) {
  const text = clean(answer, 1_500);
  if (!text) return Object.freeze({ valid: false, reason: 'empty_response' });
  const available = new Map(evidence.map((source) => [identity(source.id), source]));
  const citations = [...new Set((selectedEvidenceIds ?? []).map(identity).filter(Boolean))];
  if (!citations.length) return Object.freeze({ valid: false, reason: 'citations_required' });
  const selected = citations.map((id) => available.get(id));
  if (selected.some((source) => !source)) {
    return Object.freeze({ valid: false, reason: 'unknown_citation' });
  }
  if (selected.some((source) => (
    identity(source.tenantId) !== identity(input?.tenantId)
    || identity(source.agentId) !== identity(input?.agentId)
    || source.recordType !== 'TOOL_RESULT'
    || source.authoritativeData?.verified !== true
    || source.authoritativeData?.success !== true
  ))) return Object.freeze({ valid: false, reason: 'unverified_tool_result_evidence' });
  const claims = validateGroundedClaims(text, selected, {
    finalizedUtterance: input?.utterance,
    knownEntities: input?.memory?.knownEntities,
  });
  if (!claims.valid) return claims;
  return Object.freeze({
    valid: true,
    answer: text,
    evidenceIds: Object.freeze(selected.map((source) => source.id)),
  });
}

export function finalizeConfiguredToolResults({ input, results, runtimeProfile } = {}) {
  const values = Array.isArray(results) ? results : [];
  if (!values.length || values.some((result) => (
    result?.verified !== true || result?.success !== true
  ))) return Object.freeze({ evidence: Object.freeze([]), decision: technical('tool_success_not_verified') });

  const evidence = [];
  const messages = [];
  for (const result of values) {
    const assigned = (runtimeProfile?.tools ?? []).find((tool) => (
      identifiers(tool).has(identity(result.name))
    ));
    if (!assigned) return Object.freeze({
      evidence: Object.freeze([]), decision: technical('verified_tool_not_assigned'),
    });
    const configuredMessage = clean(schema(assigned)['x-success-message'], 800);
    const output = object(result.output);
    const callerMessage = clean(output.callerMessage ?? output.message ?? configuredMessage, 1_200);
    if (!callerMessage) return Object.freeze({
      evidence: Object.freeze(evidence),
      decision: technical('verified_tool_success_message_unconfigured'),
    });
    messages.push(callerMessage);
    evidence.push(resultEvidence(input, result, configuredMessage));
  }

  const answer = clean(messages.join(' '), 1_500);
  const validation = validateVerifiedToolSpeech({
    input,
    answer,
    selectedEvidenceIds: evidence.map((source) => source.id),
    evidence,
  });
  if (!validation.valid) return Object.freeze({
    evidence: Object.freeze(evidence),
    decision: technical(validation.reason, evidence.map((source) => source.id)),
  });
  return Object.freeze({
    evidence: Object.freeze(evidence),
    decision: createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.RESPONSE, {
      reason: 'verified_tool_success',
      evidenceIds: validation.evidenceIds,
      mode: knowledgeEngineResponseModes.DETERMINISTIC,
      response: {
        text: validation.answer,
        recordId: evidence[0]?.recordId ?? null,
        recordType: 'TOOL_RESULT',
      },
    }),
  });
}
