import { validateToolArguments } from '../tools/tool-security.js';
import { normalizedSpeechBudget } from './template-engine-speech-budget.js';
import { validateTemplateEngineDecision } from './template-engine-decision-contract.js';
import { validateTemplateEnginePostSearchDecision } from './template-engine-post-search-contract.js';
import { activateTemplateEngineWorkflow } from './template-engine-workflow-runtime.js';
export { validateTemplateEngineToolResultSpeech } from './template-engine-tool-result-validator.js';

export const TEMPLATE_ENGINE_OUTPUT_VALIDATOR_VERSION = 6;

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

function canonicalNumber(token) {
  // Dot decimals by default; comma decimals only when unambiguous.
  // In particular, 3.200 must not silently become 3200.
  const commaDecimal = /,\d{1,2}$/u.test(token)
    && (!token.includes('.') || token.lastIndexOf(',') > token.lastIndexOf('.'));
  const decimal = commaDecimal ? ',' : '.';
  const grouping = commaDecimal ? '.' : ',';
  const parts = token.split(decimal);
  if (parts.length > 2) return token;
  let integer = parts[0];
  const fraction = parts[1] ?? '';
  if (integer.includes(grouping)) {
    const groups = integer.replace(/^[+-]/u, '').split(grouping);
    const western = /^\d{1,3}$/u.test(groups[0])
      && groups.slice(1).every((part) => /^\d{3}$/u.test(part));
    const indian = /^\d{1,2}$/u.test(groups[0])
      && /^\d{3}$/u.test(groups.at(-1))
      && groups.slice(1, -1).every((part) => /^\d{2}$/u.test(part));
    if (!western && !indian) return token;
    integer = integer.split(grouping).join('');
  }
  if (!/^[+-]?\d+$/u.test(integer) || (fraction && !/^\d+$/u.test(fraction))) return token;
  const negative = integer.startsWith('-');
  integer = integer.replace(/^[+-]/u, '').replace(/^0+(?=\d)/u, '');
  const trimmedFraction = fraction.replace(/0+$/u, '');
  return `${negative && (integer !== '0' || trimmedFraction) ? '-' : ''}${integer}${trimmedFraction ? `.${trimmedFraction}` : ''}`;
}

function numericClaims(value, allowListLabels = false) {
  const text = cleanText(value);
  // Only consecutive, explicitly punctuated list markers qualify. Business
  // counts, decimals, ranges and isolated ordinals still require evidence.
  const markers = [...text.matchAll(/(?:^|\s)(\d+)[.)]\s+(?=[\p{L}\p{M}])/gu)];
  const listOffsets = new Set(allowListLabels && markers.length >= 2
    && markers.every((match, index) => Number(match[1]) === index + 1)
    ? markers.map((match) => match.index + (match[0].startsWith(' ') ? 1 : 0)) : []);
  return [...text.matchAll(/[+-]?\p{N}+(?:[.,]\p{N}+)*/gu)]
    .filter((match) => !listOffsets.has(match.index))
    .map((match) => {
      // A single hyphen after a number separates a range. Explicit negative
      // endpoints (-5--1 or -5 to -1) retain their unary minus.
      const raw = match[0].startsWith('-') && /\p{N}\s*$/u.test(text.slice(0, match.index))
        ? match[0].slice(1) : match[0];
      return { raw, normalized: canonicalNumber(raw) };
    });
}

function numbers(value) {
  return new Set(numericClaims(value).map((claim) => claim.normalized));
}

const internalFactKeys = new Set([
  'id', 'ids', 'metadata', 'internalmetadata', 'provenance', 'sourcetext',
  'rawtext', 'rawcontent', 'publicationrevision', 'revision', 'version',
  'createdat', 'updatedat', 'publishedat', 'pagenumber', 'pageend',
  'sourcelinestart', 'sourcelineend', 'score', 'rank',
]);

function publishedFactValues(value, depth = 0) {
  if (value == null || depth > 12) return [];
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => publishedFactValues(entry, depth + 1));
  if (typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    const identifier = /(?:Id|Ids|Key|Keys)$/u.test(key) || /_(?:id|ids|key|keys)$/iu.test(key)
      || ['tenantid', 'agentid', 'recordid', 'documentid', 'knowledgebaseid', 'documentversionid'].includes(normalizedKey);
    return internalFactKeys.has(normalizedKey) || identifier || key.startsWith('_')
      ? [] : publishedFactValues(entry, depth + 1);
  });
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
    ...evidence.flatMap((source) => [sourceContent(source), ...publishedFactValues(source?.authoritativeData)]
      .flatMap((value) => [...numbers(value)])),
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

function invalid(reason, { factual = false, retryCount = 0, details = null } = {}) {
  const retrySearch = factual && retryCount < 1;
  return Object.freeze({
    valid: false,
    ttsAllowed: false,
    route: retrySearch ? 'SEARCH' : 'REJECT',
    retrySearch,
    nextRetryCount: retrySearch ? retryCount + 1 : retryCount,
    reason,
    ...(details ? { details: Object.freeze(details) } : {}),
  });
}

function valid(route, value) {
  return Object.freeze({ valid: true, ttsAllowed: route === 'TTS', route, value });
}

function wordTokens(value) {
  return new Set(identity(value).split(/\s+/u).filter((token) => token.length > 1));
}

function requestedFactAddressed(response, requestedFact) {
  const requested = identity(requestedFact);
  if (!requested || ['details', 'detail', 'overview', 'general knowledge', 'explanation']
    .includes(requested)) return true;
  const responseTokens = wordTokens(response);
  const requestedTokens = wordTokens(requested);
  if ([...requestedTokens].some((token) => token === 'test' || token === 'tests')
    && responseTokens.size > 0) return true;
  if ([...requestedTokens].some((token) => responseTokens.has(token))) return true;
  if ([...requestedTokens].some((token) => token.startsWith('price'))
    && ['cost', 'costs', 'currency']
    .some((token) => responseTokens.has(token))) return true;
  return false;
}

function safeInformationUnavailableSpeech(value) {
  const speech = cleanText(value, 4_000).toLocaleLowerCase();
  if (!speech) return false;
  // NO_MATCH may describe the limits of supplied information, but it must not
  // convert an absent attribute into a real-world negative or policy claim.
  // These are generic epistemic markers, not tenant/business vocabulary.
  const informationLimited = /\b(?:information|details?|evidence|published|provided|specified|mentioned|documented|known|found)\b/iu.test(speech)
    || /(?:தகவல்|விவர|ஆதார|குறிப்பிட|தெரிய)/u.test(speech);
  const categoricalNegative = /\b(?:not required|not available|does not exist|doesn't exist|never offered|not allowed|ineligible)\b/iu.test(speech)
    || /(?:தேவையில்லை|கிடையாது|இல்லவே இல்லை|அனுமதி இல்லை|தகுதி இல்லை)/u.test(speech);
  const explicitlyInformationLimited = /\b(?:information|details?|evidence)\s+(?:is\s+|are\s+)?(?:not available|unavailable)\b/iu.test(speech);
  return informationLimited && (!categoricalNegative || explicitlyInformationLimited);
}

function selectedEvidenceFor(decision, evidence) {
  const byId = new Map(evidence.map((source) => [
    cleanText(source.evidenceId ?? source.sourceId ?? source.id, 160), source,
  ]));
  const citations = Array.isArray(decision.evidenceIds) ? decision.evidenceIds : [];
  if (citations.some((id) => !byId.has(cleanText(id, 160)))) return null;
  return citations.map((id) => byId.get(cleanText(id, 160)));
}

function normalizedRecordIds(values = []) {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanText(value, 160).toLocaleLowerCase()).filter(Boolean));
}

function sameRecordSet(evidence, requiredValues) {
  const required = normalizedRecordIds(requiredValues);
  if (!required.size) return true;
  const cited = normalizedRecordIds(evidence.map((source) => source?.recordId));
  if (required.size !== cited.size) return false;
  for (const value of required) if (!cited.has(value)) return false;
  return true;
}

function validateResponse(decision, input) {
  const factual = input.factualClaimsPresent === true;
  const deterministicOnly = input.deterministicOnly === true;
  const requestedFact = cleanText(input.searchInterpretation?.requestedFact, 500);
  if (input.ambiguity?.required === true) {
    return invalid('clarification_required_for_entity_resolution', {
      factual, retryCount: input.retryCount,
    });
  }
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
  if (!sameRecordSet(selectedEvidence, input.requiredEvidenceRecordIds)) {
    return invalid('comparison_requires_exact_requested_records', {
      factual: true, retryCount: input.retryCount,
    });
  }
  if (selectedEvidence.some((source) => (
    source?.verified !== true || source?.callerFacing === false
  ))) {
    return invalid('unverified_cited_evidence', { factual: true, retryCount: input.retryCount });
  }
  const permittedNumbers = allowedNumbers(selectedEvidence, input.callerProvidedValues);
  const unsupportedNumbers = numericClaims(
    [decision.response, decision.nextQuestion?.question].filter(Boolean).join(' '),
    deterministicOnly,
  )
    .filter((claim) => !permittedNumbers.has(claim.normalized));
  if (unsupportedNumbers.length) {
    return invalid('unsupported_numeric_claim', {
      factual: true, retryCount: input.retryCount,
      details: {
        unsupportedNumbers: Object.freeze(unsupportedNumbers.map(Object.freeze)),
        checkedEvidenceIds: Object.freeze([...decision.evidenceIds]),
      },
    });
  }
  const comparisonRequest = (input.requiredEvidenceRecordIds ?? []).length > 1
    && /(?:compar|differ)/iu.test(requestedFact);
  const focusedRequestedFact = [...wordTokens(requestedFact)].length <= 4;
  if (requestedFact && focusedRequestedFact && !comparisonRequest
    && !requestedFactAddressed(decision.response, requestedFact)) {
    return invalid('requested_fact_not_addressed', {
      factual: true, retryCount: input.retryCount,
    });
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
  const completeMultiRecordEvidence = citedRecordIds.size > 1 && deterministicOnly;
  if (!evidenceSupportsRelationship(
    mentioned, selectedEvidence,
    input.allowMultipleEntities === true || completeMultiRecordEvidence,
  )) {
    return invalid('unsupported_relationship_claim', { factual: true, retryCount: input.retryCount });
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
  if (input.clarificationRelevant === false) {
    return invalid('irrelevant_or_unsupported_clarification');
  }
  const allowedCandidates = new Set((input.ambiguity?.candidates ?? []).map(identity).filter(Boolean));
  const selectedCandidates = clarification.candidates.map(identity).filter(Boolean);
  const ambiguityKind = cleanText(input.ambiguity?.kind, 80);
  const unresolved = ambiguityKind === 'unresolved_published_entity'
    || ambiguityKind === 'unresolved_action_intent';
  const confirmation = ambiguityKind === 'published_entity_confirmation';
  if (unresolved && selectedCandidates.length) {
    return invalid('invented_clarification_candidate');
  }
  const proposesUnverifiedCandidate = /\b(?:did|do)\s+you\s+mean\s+(?!which\b|what\b|who\b|where\b|when\b|how\b)/iu
    .test(clarification.question);
  if (unresolved && allowedCandidates.size === 0 && proposesUnverifiedCandidate) {
    return invalid('invented_clarification_candidate');
  }
  if (!unresolved && !confirmation
    && (allowedCandidates.size < 2 || selectedCandidates.length < 2)) {
    return invalid('clarification_candidates_required');
  }
  if (confirmation && (allowedCandidates.size !== 1 || selectedCandidates.length !== 1)) {
    return invalid('clarification_candidate_confirmation_required');
  }
  if (selectedCandidates.some((candidate) => !allowedCandidates.has(candidate))) {
    return invalid('invented_clarification_candidate');
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
    // Preserve only configuration identifiers, never arguments, questions,
    // credentials or arbitrary underlying error details in diagnostics.
    const details = error.code === 'TEMPLATE_ENGINE_WORKFLOW_FIELD_CONFIGURATION_MISSING'
      ? { fields: [...(error.details?.fields ?? [])],
        toolId: error.details?.toolId ?? null,
        schemaDiagnostics: error.details?.schemaDiagnostics ?? null,
        fieldIssues: (error.details?.fieldIssues ?? []).map(({ field, reason }) => ({ field, reason })) }
      : null;
    return invalid(error.code ?? 'tool_not_authorized', { details });
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
  const maximumSpeechCharacters = normalizedSpeechBudget(input.maximumSpeechCharacters);
  const answer = decision.decision === 'CLARIFY' ? decision.clarification?.question
    : [cleanText(decision.response), cleanText(decision.nextQuestion?.question)].filter(Boolean).join(' ');
  if (maximumSpeechCharacters && cleanText(answer).length > maximumSpeechCharacters) {
    return invalid('speech_budget_exceeded', { factual: input.factualClaimsPresent === true,
      retryCount: input.retryCount, details: { maximumSpeechCharacters,
        actualSpeechCharacters: cleanText(answer).length,
        answerCharacters: cleanText(decision.response).length,
        followUpCharacters: cleanText(decision.nextQuestion?.question).length } });
  }
  if (decision.decision === 'RESPONSE') return validateResponse(decision, input);
  if (decision.decision === 'CLARIFY') return validateClarification(decision, input);
  if (decision.decision === 'TOOL') return validateTool(decision, input);
  if (decision.decision === 'SEARCH') return valid('SEARCH', decision);
  if (decision.decision === 'NO_MATCH') {
    if (internalOrJson(decision.response)) return invalid('invalid_no_match_speech', {
      factual: input.factualClaimsPresent === true, retryCount: input.retryCount,
    });
    if (input.requestedFactAvailable === true) {
      return invalid('no_match_rejected_when_requested_fact_is_available', {
        factual: true, retryCount: input.retryCount,
      });
    }
    if (input.ambiguity?.required === true) {
      return invalid('clarification_required_for_entity_resolution', {
        factual: true, retryCount: input.retryCount,
      });
    }
    if (!safeInformationUnavailableSpeech(decision.response)) {
      return invalid('unsafe_no_match_claim', {
        factual: input.factualClaimsPresent === true, retryCount: input.retryCount,
      });
    }
    return valid('TTS', decision);
  }
  return invalid('unsupported_decision');
}
