import { validateToolArguments } from '../tools/tool-security.js';
import { validateTemplateEngineDecision } from './template-engine-decision-contract.js';
import { validateTemplateEnginePostSearchDecision } from './template-engine-post-search-contract.js';
import { activateTemplateEngineWorkflow } from './template-engine-workflow-runtime.js';
export { validateTemplateEngineToolResultSpeech } from './template-engine-tool-result-validator.js';

export const TEMPLATE_ENGINE_OUTPUT_VALIDATOR_VERSION = 1;

function cleanText(value, maximum = 8_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) {
  return cleanText(value).toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function internalOrJson(value) {
  const speech = cleanText(value);
  if (!speech) return true;
  if (/```|<(?:platform|tenant|orchestrator|workflow|runtime)_[^>]*>/iu.test(speech)
    || /"(?:decision|stateUpdate|evidenceIds|tool|search)"\s*:/iu.test(speech)) return true;
  if ((speech.startsWith('{') && speech.endsWith('}'))
    || (speech.startsWith('[') && speech.endsWith(']'))) {
    try { JSON.parse(speech); return true; } catch { /* natural speech punctuation */ }
  }
  return false;
}

function numbers(value) {
  return new Set(cleanText(value).match(/[+-]?\p{N}+(?:[.,]\p{N}+)?/gu) ?? []);
}

function sourceContent(source) {
  return cleanText([
    source?.content,
    source?.canonicalName,
    ...(Array.isArray(source?.aliases) ? source.aliases : []),
  ].filter(Boolean).join(' '));
}

function allowedNumbers(evidence, callerValues) {
  return new Set([
    ...evidence.flatMap((source) => [...numbers(sourceContent(source))]),
    ...[...numbers(JSON.stringify(callerValues ?? {}))],
  ]);
}

function entitiesMentioned(speech, entityIndex = [], claimedNames = []) {
  const normalizedSpeech = identity(speech);
  const mentioned = [];
  for (const entity of entityIndex) {
    const names = [entity?.canonicalName, entity?.name, ...(entity?.aliases ?? [])]
      .map(identity).filter((name) => name.length >= 3);
    if (names.some((name) => normalizedSpeech.includes(name))) mentioned.push(entity);
  }
  for (const name of claimedNames ?? []) {
    const normalized = identity(name);
    if (!normalized || mentioned.some((entity) => [
      entity?.canonicalName, entity?.name, ...(entity?.aliases ?? []),
    ].map(identity).includes(normalized))) continue;
    mentioned.push({ recordId: null, canonicalName: cleanText(name, 300), unindexed: true });
  }
  return mentioned;
}

function evidenceSupportsEntity(entity, selectedEvidence) {
  if (entity.unindexed) {
    const wanted = identity(entity.canonicalName);
    return selectedEvidence.some((source) => identity(sourceContent(source)).includes(wanted));
  }
  const recordId = cleanText(entity.recordId ?? entity.id, 160).toLocaleLowerCase();
  const names = [entity?.canonicalName, entity?.name, ...(entity?.aliases ?? [])]
    .map(identity).filter(Boolean);
  return selectedEvidence.some((source) => (
    cleanText(source?.recordId, 160).toLocaleLowerCase() === recordId
    || names.some((name) => identity(sourceContent(source)).includes(name))
  ));
}

function evidenceSupportsRelationship(entities, selectedEvidence, allowMultipleEntities) {
  if (entities.length < 2) return true;
  if (allowMultipleEntities === true) return entities.every((entity) => (
    evidenceSupportsEntity(entity, selectedEvidence)
  ));
  return selectedEvidence.some((source) => {
    const content = identity(sourceContent(source));
    const relatedIds = new Set((source?.relationships ?? [])
      .map((relationship) => cleanText(
        relationship?.recordId ?? relationship?.targetRecordId ?? relationship, 160,
      ).toLocaleLowerCase()));
    return entities.every((entity) => {
      const recordId = cleanText(entity.recordId ?? entity.id, 160).toLocaleLowerCase();
      const names = [entity?.canonicalName, entity?.name, ...(entity?.aliases ?? [])]
        .map(identity).filter(Boolean);
      return relatedIds.has(recordId) || names.some((name) => content.includes(name));
    });
  });
}

function invalid(reason, { factual = false, retryCount = 0 } = {}) {
  const retrySearch = factual && retryCount < 1;
  return Object.freeze({
    valid: false,
    ttsAllowed: false,
    route: retrySearch ? 'SEARCH' : 'REJECT',
    retrySearch,
    nextRetryCount: retrySearch ? retryCount + 1 : retryCount,
    reason,
  });
}

function valid(route, value) {
  return Object.freeze({ valid: true, ttsAllowed: route === 'TTS', route, value });
}

function selectedEvidenceFor(decision, evidence) {
  const byId = new Map(evidence.map((source) => [
    cleanText(source.evidenceId ?? source.sourceId ?? source.id, 160), source,
  ]));
  const citations = Array.isArray(decision.evidenceIds) ? decision.evidenceIds : [];
  if (citations.some((id) => !byId.has(cleanText(id, 160)))) return null;
  return citations.map((id) => byId.get(cleanText(id, 160)));
}

function validateResponse(decision, input) {
  const factual = input.factualClaimsPresent === true;
  if (internalOrJson(decision.response)) {
    return invalid('internal_or_json_speech', { factual, retryCount: input.retryCount });
  }
  const selectedEvidence = selectedEvidenceFor(decision, input.selectedEvidence ?? []);
  if (selectedEvidence === null) return invalid('invalid_citation', { factual, retryCount: input.retryCount });
  if (!factual) {
    if (input.nonFactualResponseAllowed !== true || selectedEvidence.length) {
      return invalid('non_factual_response_not_allowed');
    }
    return valid('TTS', decision);
  }
  if (!selectedEvidence.length) {
    return invalid('factual_response_requires_evidence', {
      factual: true, retryCount: input.retryCount,
    });
  }
  if (selectedEvidence.some((source) => (
    source?.verified !== true || source?.callerFacing === false
  ))) {
    return invalid('unverified_cited_evidence', { factual: true, retryCount: input.retryCount });
  }
  const permittedNumbers = allowedNumbers(selectedEvidence, input.callerProvidedValues);
  const unsupportedNumbers = [...numbers(decision.response)]
    .filter((number) => !permittedNumbers.has(number));
  if (unsupportedNumbers.length) {
    return invalid('unsupported_numeric_claim', { factual: true, retryCount: input.retryCount });
  }
  const mentioned = entitiesMentioned(
    decision.response, input.publishedEntities, input.claimedNames,
  );
  if (mentioned.some((entity) => !evidenceSupportsEntity(entity, selectedEvidence))) {
    return invalid('unsupported_entity_claim', { factual: true, retryCount: input.retryCount });
  }
  const citedRecordIds = new Set(selectedEvidence.map((source) => (
    cleanText(source?.recordId, 160).toLocaleLowerCase()
  )).filter(Boolean));
  const completeMultiRecordEvidence = citedRecordIds.size > 1
    && input.semanticClaimValidation?.supported === true;
  if (!evidenceSupportsRelationship(
    mentioned, selectedEvidence,
    input.allowMultipleEntities === true || completeMultiRecordEvidence,
  )) {
    return invalid('unsupported_relationship_claim', { factual: true, retryCount: input.retryCount });
  }
  if (input.semanticClaimValidation?.supported !== true) {
    return invalid(input.semanticClaimValidation
      ? 'unsupported_factual_claim' : 'grounding_validation_missing', {
      factual: true, retryCount: input.retryCount,
    });
  }
  return valid('TTS', decision);
}

function validateClarification(decision, input) {
  const clarification = decision.clarification;
  if (!clarification || internalOrJson(clarification.question)) {
    return invalid('invalid_clarification');
  }
  const questionMarks = (clarification.question.match(/[?？]/gu) ?? []).length;
  if (questionMarks > 1) return invalid('multiple_clarification_questions');
  if (input.ambiguity?.required !== true) return invalid('clarification_not_required');
  if (input.clarificationRelevant === false
    || input.semanticClaimValidation?.supported === false
    || (input.claimValidationRequired === true
      && input.semanticClaimValidation?.supported !== true)) {
    return invalid('irrelevant_or_unsupported_clarification');
  }
  const allowedCandidates = new Set((input.ambiguity?.candidates ?? []).map(identity).filter(Boolean));
  const selectedCandidates = clarification.candidates.map(identity).filter(Boolean);
  if (allowedCandidates.size && !selectedCandidates.length) {
    return invalid('clarification_candidates_required');
  }
  if (selectedCandidates.some((candidate) => !allowedCandidates.has(candidate))) {
    return invalid('invented_clarification_candidate');
  }
  if (input.ambiguity?.kind === 'contextual_reference'
    && (allowedCandidates.size < 2 || selectedCandidates.length < 2)) {
    return invalid('contextual_clarification_not_ambiguous');
  }
  const permittedNumbers = new Set([
    ...numbers(input.currentUtterance),
    ...numbers(JSON.stringify(input.ambiguity?.candidates ?? [])),
    ...numbers(JSON.stringify(input.callerProvidedValues ?? {})),
  ]);
  if ([...numbers(clarification.question)].some((number) => !permittedNumbers.has(number))) {
    return invalid('invented_clarification_fact');
  }
  return valid('TTS', decision);
}

function validateTool(decision, input) {
  let activation;
  try {
    activation = activateTemplateEngineWorkflow({
      toolDecision: decision,
      state: input.state,
      publishedWorkflows: input.publishedWorkflows,
      assignedTools: input.assignedTools,
      informationFields: input.informationFields,
      scope: input.scope,
    });
  } catch (error) {
    return invalid(error.code ?? 'tool_not_authorized');
  }
  if (input.toolExecutionRequested === true) {
    const confirmed = input.confirmation?.accepted === true
      && input.confirmation?.explicit === true
      && input.state?.confirmationStatus === 'awaiting_confirmation';
    if (!activation.progress.complete || !confirmed) return invalid('tool_execution_not_ready');
    try {
      validateToolArguments(
        activation.state.collectedToolFields, activation.configuration.inputSchema,
      );
    } catch {
      return invalid('tool_arguments_invalid');
    }
    return valid('EXECUTE_TOOL', activation);
  }
  return valid('WORKFLOW', activation);
}

export function validateTemplateEngineOutput(input = {}) {
  const evidenceIds = (input.selectedEvidence ?? []).map((source) => cleanText(
    source?.evidenceId ?? source?.sourceId ?? source?.id, 160,
  )).filter(Boolean);
  const parsed = input.phase === 'post_search'
    ? validateTemplateEnginePostSearchDecision(input.decision, evidenceIds)
    : validateTemplateEngineDecision(input.decision);
  if (!parsed.valid) return invalid(parsed.reason, {
    factual: input.factualClaimsPresent === true,
    retryCount: input.retryCount,
  });
  const decision = parsed.value;
  if (decision.decision === 'RESPONSE') return validateResponse(decision, input);
  if (decision.decision === 'CLARIFY') return validateClarification(decision, input);
  if (decision.decision === 'TOOL') return validateTool(decision, input);
  if (decision.decision === 'SEARCH') return valid('SEARCH', decision);
  if (decision.decision === 'NO_MATCH') {
    if (internalOrJson(decision.response)) return invalid('invalid_no_match_speech', {
      factual: input.factualClaimsPresent === true, retryCount: input.retryCount,
    });
    if (input.claimValidationRequired === true
      && input.semanticClaimValidation?.supported !== true) {
      return invalid(input.semanticClaimValidation
        ? 'unsupported_no_match_claim' : 'grounding_validation_missing', {
        factual: true, retryCount: input.retryCount,
      });
    }
    return valid('TTS', decision);
  }
  return invalid('unsupported_decision');
}
