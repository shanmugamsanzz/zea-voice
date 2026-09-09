import { AppError } from '../../middleware/errors.js';
import { createTemplateEngineAnswerContext, firstPassAnswerInstruction } from './template-engine-answer-context.js';
import { tagTemplateEngineTiming } from './template-engine-turn-timing.js';
import { speechBudgetInstruction } from './template-engine-speech-budget.js';
import { createMinimalTemplateEngineState } from './template-engine-state.js';
import { normalizeTemplateEngineSearchDecision } from './template-engine-search-request.js';
import {
  templateEnginePostSearchJsonSchema,
  templateEnginePostSearchJsonSchemaForEvidenceAliases,
  templateEnginePostSearchDecisionDiagnostics,
  validateTemplateEnginePostSearchDecision,
} from './template-engine-post-search-contract.js';
import {
  buildTemplateEngineGroundedAnswerPrompt,
} from './template-engine-routing-control.js';
import { validateTemplateEngineOutput } from './template-engine-output-validator.js';
import {
  sanitizeConversationGuidance,
} from './template-engine-conversation-guidance.js';
import { shortenSupportedTemplateEngineDecision } from './template-engine-speech-composer.js';

const maximumRecentPairs = 5;

function cleanText(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function cleanList(value, maximumItems = 50) {
  return Object.freeze([...new Set((Array.isArray(value) ? value : [])
    .map((entry) => cleanText(entry, 160)).filter(Boolean))].slice(0, maximumItems));
}

function unsupportedAcronyms(speech, evidence) {
  const asserted = new Set((cleanText(speech).match(/[A-Z][A-Z\p{N}]{1,}/gu) ?? [])
    .map((value) => value.toLocaleLowerCase()));
  if (!asserted.size) return Object.freeze([]);
  const corpus = cleanText(evidence.map((source) => [
    source?.content, source?.canonicalName, ...(source?.aliases ?? []),
    JSON.stringify(source?.authoritativeData ?? {}),
  ].join(' ')).join(' ')).toLocaleLowerCase();
  return Object.freeze([...asserted].filter((term) => !corpus.includes(term)));
}

function cleanPendingQuestion(value) {
  if (!value) return null;
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value : { text: value };
  const text = cleanText(source.text ?? source.question, 1_000);
  if (!text) return null;
  return Object.freeze({
    key: cleanText(source.key, 160) || null,
    text,
    kind: cleanText(source.kind, 80) || null,
  });
}

function authorizedSummaries(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const summaries = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const toolName = cleanText(entry.toolName ?? entry.name, 160);
    if (!toolName || seen.has(toolName)) continue;
    seen.add(toolName);
    const requiredFields = [...new Set((Array.isArray(entry.requiredFields)
      ? entry.requiredFields : entry.inputSchema?.required ?? [])
      .map((field) => cleanText(field, 160)).filter(Boolean))].slice(0, 50);
    summaries.push(Object.freeze({
      workflowRecordId: cleanText(entry.workflowRecordId ?? entry.recordId, 160) || null,
      toolName,
      description: cleanText(entry.description, 500) || null,
      requiredFields: Object.freeze(requiredFields),
    }));
    if (summaries.length >= 20) break;
  }
  return Object.freeze(summaries);
}

function completionOutput(completion) {
  if (completion && typeof completion === 'object') {
    return completion.outputParsed ?? completion.output_parsed ?? completion.parsed
      ?? completion.answer ?? completion.output ?? completion.text ?? completion;
  }
  return completion;
}

function outputValidationInput(decision, orchestratorInput, dependencies, additions = {}) {
  return Object.freeze({
    decision,
    state: orchestratorInput.state,
    currentUtterance: orchestratorInput.latestUtterance,
    factualClaimsPresent: dependencies.factualClaimsPresent === true,
    nonFactualResponseAllowed: dependencies.nonFactualResponseAllowed === true,
    selectedEvidence: dependencies.verifiedEvidence ?? [],
    publishedEntities: dependencies.publishedEntities ?? [],
    claimedNames: dependencies.claimedNames ?? [],
    callerProvidedValues: dependencies.callerProvidedValues ?? {},
    allowMultipleEntities: dependencies.allowMultipleEntities === true,
    ambiguity: dependencies.ambiguity ?? null,
    retryCount: Number.isInteger(dependencies.validationRetryCount)
      ? dependencies.validationRetryCount : 0,
    publishedWorkflows: dependencies.publishedWorkflows ?? [],
    assignedTools: dependencies.assignedTools ?? [],
    informationFields: dependencies.informationFields ?? [],
    scope: dependencies.scope ?? {},
    confirmation: dependencies.confirmation ?? null,
    toolExecutionRequested: dependencies.toolExecutionRequested === true,
    requiredEvidenceRecordIds: dependencies.requiredEvidenceRecordIds ?? [],
    requestedFactAvailable: dependencies.requestedFactAvailable === true,
    maximumSpeechCharacters: dependencies.maximumSpeechCharacters,
    ...additions,
  });
}

export function createTemplateEngineOrchestratorInput({
  mainPrompt,
  latestUtterance,
  conversationHistory = [],
  recentPairLimit = maximumRecentPairs,
  pendingClarification = null,
  activeWorkflowState = null,
  citedRecordReferences = [],
  lastReferencedRecordIds = null,
  comparisonRecordIds = [],
  activeWorkflowId = null,
  collectedToolFields = null,
  confirmationStatus = null,
  authorizedWorkflowTools = [],
  conversationGuidance = null,
  pendingQuestion = null,
  welcomeContinuation = null,
  unansweredRequest = null,
} = {}) {
  const utterance = cleanText(latestUtterance);
  if (!utterance) throw new TypeError('A finalized caller utterance is required');
  const prompt = cleanText(mainPrompt, 24_000);
  if (!prompt) throw new TypeError('A tenant main prompt is required');
  const minimalState = createMinimalTemplateEngineState({
    conversationHistory,
    recentPairLimit,
    lastReferencedRecordIds: lastReferencedRecordIds ?? citedRecordReferences,
    comparisonRecordIds,
    pendingClarification,
    activeWorkflowId,
    activeWorkflowState,
    collectedToolFields,
    confirmationStatus,
  });
  return Object.freeze({
    mainPrompt: prompt,
    latestUtterance: utterance,
    state: minimalState,
    authorizedWorkflowTools: authorizedSummaries(authorizedWorkflowTools),
    conversationGuidance: sanitizeConversationGuidance(conversationGuidance),
    pendingQuestion: cleanPendingQuestion(pendingQuestion),
    welcomeContinuation,
    unansweredRequest: cleanText(unansweredRequest, 4_000) || null,
  });
}


function sameScopeValue(value, expected) {
  return cleanText(value, 160).toLocaleLowerCase()
    === cleanText(expected, 160).toLocaleLowerCase();
}

function verifiedEvidenceForPostSearch(values, scope = {}) {
  const scopeTenantId = cleanText(scope.tenantId, 160);
  const scopeAgentId = cleanText(scope.agentId, 160);
  const publications = new Set((Array.isArray(scope.publications) ? scope.publications : [])
    .map((publication) => (
      `${cleanText(publication?.knowledgeBaseId, 160).toLocaleLowerCase()}`
      + `:${Number(publication?.publicationRevision)}`
    )));
  if (!scopeTenantId || !scopeAgentId || !publications.size) {
    throw new TypeError('Post-search evidence requires tenant, agent and publication scope');
  }
  const evidence = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const evidenceId = cleanText(value?.evidenceId ?? value?.sourceId ?? value?.id, 160);
    const recordId = cleanText(value?.recordId, 160);
    const recordType = cleanText(value?.recordType, 80).toLocaleUpperCase();
    const tenantId = cleanText(value?.tenantId, 160);
    const agentId = cleanText(value?.agentId, 160);
    const knowledgeBaseId = cleanText(value?.knowledgeBaseId, 160);
    const publicationRevision = Number(value?.publicationRevision);
    const content = cleanText(value?.content, 8_000);
    const publicationKey = `${knowledgeBaseId.toLocaleLowerCase()}:${publicationRevision}`;
    if (value?.verified !== true || value?.callerFacing === false) continue;
    if (!evidenceId || !recordId || !recordType || !tenantId || !knowledgeBaseId
      || !Number.isInteger(publicationRevision) || !content
      || !sameScopeValue(tenantId, scopeTenantId)
      || (agentId && !sameScopeValue(agentId, scopeAgentId))
      || !publications.has(publicationKey)) {
      throw new AppError(500, 'Verified post-search evidence is outside its runtime scope',
        'TEMPLATE_ENGINE_POST_SEARCH_SCOPE_VIOLATION', {
          evidenceId: evidenceId || null, recordId: recordId || null,
        });
    }
    if (seen.has(evidenceId)) continue;
    seen.add(evidenceId);
    evidence.push(Object.freeze({
      verified: true, callerFacing: true,
      evidenceId, recordId, recordType, tenantId,
      agentId: agentId || scopeAgentId,
      knowledgeBaseId, publicationRevision, content,
      canonicalName: cleanText(value?.canonicalName, 300) || null,
      aliases: cleanList(value?.aliases, 50),
      relationships: Object.freeze([...(Array.isArray(value?.relationships)
        ? value.relationships : [])]),
      authoritativeData: value?.authoritativeData
        && typeof value.authoritativeData === 'object'
        && !Array.isArray(value.authoritativeData)
        ? Object.freeze({ ...value.authoritativeData }) : Object.freeze({}),
      requestedFact: cleanText(value?.requestedFact, 500) || null,
      publishedAttributePaths: Object.freeze(cleanList(
        value?.publishedAttributePaths, 120,
      )),
    }));
    if (evidence.length >= 20) break;
  }
  return Object.freeze(evidence);
}

function aliasPostSearchEvidence(evidence) {
  const aliasToEvidenceId = new Map();
  const aliasedEvidence = evidence.map((entry, index) => {
    const evidenceId = `E${index + 1}`;
    aliasToEvidenceId.set(evidenceId, entry.evidenceId);
    return Object.freeze({
      ...entry,
      // Provider-facing citations are intentionally short and turn-scoped.
      // The real identifier never has to be reproduced by the LLM.
      evidenceId,
    });
  });
  return Object.freeze({
    evidence: Object.freeze(aliasedEvidence),
    aliases: Object.freeze([...aliasToEvidenceId.keys()]),
    aliasToEvidenceId,
  });
}

function recordId(value) {
  return cleanText(value, 160).toLocaleLowerCase();
}

function evidenceForRequestedEntities(evidence, requestedRecordIds = []) {
  const required = new Set(cleanList(requestedRecordIds, 100).map(recordId).filter(Boolean));
  if (!required.size) return evidence;
  return Object.freeze(evidence.filter((source) => required.has(recordId(source?.recordId))));
}

function candidateIdentity(value) {
  return cleanText(value, 300).toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function evidenceProvidesRequestedFact(evidence, requestedFact) {
  const normalizedFact = candidateIdentity(requestedFact);
  if (!normalizedFact) return false;
  if (['details', 'detail', 'overview', 'general knowledge', 'explanation']
    .includes(normalizedFact)) return evidence.length > 0;
  const wanted = new Set(normalizedFact.split(/\s+/u).filter(Boolean));
  return evidence.some((source) => {
    const searchable = candidateIdentity([
      ...(source?.publishedAttributePaths ?? []),
      source?.canonicalName,
      ...(source?.aliases ?? []),
      source?.content,
      JSON.stringify(source?.authoritativeData ?? {}),
    ].join(' '));
    const available = new Set(searchable.split(/\s+/u).filter(Boolean));
    let matches = 0;
    for (const token of wanted) if (available.has(token)) matches += 1;
    return matches > 0 && matches / wanted.size >= 0.5;
  });
}

function evidenceSupportingRequestedFact(evidence, requestedFact) {
  const normalizedFact = candidateIdentity(requestedFact);
  if (!normalizedFact) return Object.freeze([]);
  if (['details', 'detail', 'overview', 'general knowledge', 'explanation']
    .includes(normalizedFact)) return Object.freeze([...evidence]);
  const wanted = new Set(normalizedFact.split(/\s+/u).filter(Boolean));
  return Object.freeze(evidence.filter((source) => {
    const searchable = candidateIdentity([
      ...(source?.publishedAttributePaths ?? []),
      source?.content,
      JSON.stringify(source?.authoritativeData ?? {}),
    ].join(' '));
    const available = new Set(searchable.split(/\s+/u).filter(Boolean));
    let matches = 0;
    for (const token of wanted) if (available.has(token)) matches += 1;
    return matches > 0 && matches / wanted.size >= 0.5;
  }));
}

function completeSpeechFragments(value) {
  const speech = cleanText(value, 8_000);
  if (!speech) return Object.freeze([]);
  const sentences = speech.match(/[^.!?\u0964\u061f\u3002]+[.!?\u0964\u061f\u3002]?/gu)
    ?.map((sentence) => cleanText(sentence, 8_000)).filter(Boolean) ?? [];
  return Object.freeze(sentences.length ? sentences : [speech]);
}

function publishedScalarFragments(source, requestedFact, value = source?.authoritativeData,
  path = '', depth = 0, result = []) {
  if (value === null || value === undefined || depth > 6 || result.length >= 100) return result;
  if (Array.isArray(value)) {
    for (const entry of value) {
      publishedScalarFragments(source, requestedFact, entry, path, depth + 1, result);
    }
    return result;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      publishedScalarFragments(source, requestedFact, entry, path ? `${path}.${key}` : key,
        depth + 1, result);
    }
    return result;
  }
  const normalizedPath = candidateIdentity(path);
  const requestedTokens = new Set(candidateIdentity(requestedFact).split(/\s+/u).filter(Boolean));
  const pathTokens = normalizedPath.split(/\s+/u).filter(Boolean);
  const published = (source?.publishedAttributePaths ?? []).some((publishedPath) => {
    const normalizedPublishedPath = candidateIdentity(publishedPath);
    return normalizedPublishedPath === normalizedPath
      || normalizedPublishedPath.endsWith(` ${normalizedPath}`)
      || normalizedPath.endsWith(` ${normalizedPublishedPath}`);
  });
  if (!published || !pathTokens.some((token) => requestedTokens.has(token))) return result;
  const scalar = cleanText(value, 1_000);
  if (!scalar) return result;
  const canonicalName = cleanText(source?.canonicalName, 300);
  const callerReadyText = typeof value === 'string'
    && (scalar.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 4;
  result.push(callerReadyText
    ? scalar
    : `${canonicalName ? `${canonicalName}: ` : ''}${path}: ${scalar}.`);
  return result;
}

function relevantFragment(source, requestedFact) {
  const wanted = new Set(candidateIdentity(requestedFact).split(/\s+/u).filter(Boolean));
  const canonicalTokens = new Set(candidateIdentity(source?.canonicalName)
    .split(/\s+/u).filter(Boolean));
  const candidates = [
    ...publishedScalarFragments(source, requestedFact),
    ...completeSpeechFragments(source?.authoritativeData?.callerFacingAnswer),
    ...completeSpeechFragments(source?.authoritativeData?.answer),
    ...completeSpeechFragments(source?.content),
  ];
  const unique = [...new Set(candidates)].filter((fragment) => (
    candidateIdentity(fragment).split(/\s+/u).filter(Boolean).length >= 2
  ));
  if (!unique.length) return null;
  const ranked = unique.map((fragment, index) => {
    const tokens = new Set(candidateIdentity(fragment).split(/\s+/u).filter(Boolean));
    let factMatches = 0;
    let nameMatches = 0;
    for (const token of wanted) if (tokens.has(token)) factMatches += 1;
    for (const token of canonicalTokens) if (tokens.has(token)) nameMatches += 1;
    return Object.freeze({ fragment, index, factMatches, nameMatches,
      numeric: /\p{N}/u.test(fragment) ? 1 : 0 });
  }).sort((left, right) => (
    right.factMatches - left.factMatches
      || right.nameMatches - left.nameMatches
      || right.numeric - left.numeric
      || left.fragment.length - right.fragment.length
      || left.index - right.index
  ));
  return ranked[0]?.fragment ?? null;
}

function extractiveGroundedRecovery(evidence, requestedFact, {
  maximumSpeechCharacters = null, requiredRecordIds = [],
} = {}) {
  const requiredCount = new Set(cleanList(requiredRecordIds, 100)
    .map(recordId).filter(Boolean)).size;
  const required = evidenceForRequestedEntities(evidence, requiredRecordIds);
  const supporting = requiredCount
    ? required : evidenceSupportingRequestedFact(evidence, requestedFact);
  if (!supporting.length || (requiredCount && supporting.length !== requiredCount)) {
    return null;
  }
  const budget = Number(maximumSpeechCharacters);
  const bounded = Number.isFinite(budget) && budget > 0;
  const candidates = supporting.map((source) => {
    const fragment = relevantFragment(source, requestedFact);
    const name = cleanText(source?.canonicalName, 300);
    const speech = fragment && supporting.length > 1 && name
      && !candidateIdentity(fragment).includes(candidateIdentity(name))
      ? `${name}: ${fragment}` : fragment;
    return Object.freeze({ source, speech });
  });

  // Explicitly requested records (notably comparison operands) remain
  // all-or-nothing. For an aggregate/category answer, retrieval order is the
  // relevance order, so pack as many complete verified record fragments as
  // fit and cite only the records that are actually spoken.
  if (requiredCount && candidates.some(({ speech }) => !speech)) return null;
  const selected = [];
  const seenSpeech = new Set();
  let response = '';
  for (const candidate of candidates) {
    if (!candidate.speech || seenSpeech.has(candidate.speech)) continue;
    const combined = response ? `${response} ${candidate.speech}` : candidate.speech;
    if (bounded && combined.length > budget) {
      if (requiredCount) return null;
      continue;
    }
    response = combined;
    selected.push(candidate.source);
    seenSpeech.add(candidate.speech);
  }
  response = response.trim();
  if (!response || !selected.length || (requiredCount && selected.length !== requiredCount)) {
    return null;
  }
  return Object.freeze({
    decision: 'RESPONSE', response, clarification: null,
    evidenceIds: Object.freeze(selected.map((source) => source.evidenceId)),
    nextQuestion: null, stateUpdate: null,
  });
}

function fullExtractiveGroundedRecovery(evidence, requestedFact) {
  const supporting = evidenceSupportingRequestedFact(evidence, requestedFact);
  if (!supporting.length) return null;
  const speechParts = [...new Set(supporting.map((source) => cleanText(
    source?.authoritativeData?.callerFacingAnswer
      ?? source?.authoritativeData?.answer
      ?? source?.content,
    4_000,
  )).filter(Boolean))];
  const response = cleanText(speechParts.join(' '), 4_000);
  if (!response) return null;
  return Object.freeze({
    decision: 'RESPONSE', response, clarification: null,
    evidenceIds: Object.freeze(supporting.map((source) => source.evidenceId)),
    nextQuestion: null, stateUpdate: null,
  });
}

function evidenceCandidateNames(source) {
  return cleanList([source?.canonicalName, ...(source?.aliases ?? [])], 60)
    .map(candidateIdentity).filter(Boolean);
}

function verifiedClarificationAmbiguity(decision, evidence, searchInterpretation, supplied) {
  // Hydrating an old preference is not proof of what the caller meant now.
  const preferred = new Set((searchInterpretation?.preferredRecordIds ?? [])
    .map(recordId).filter(Boolean));
  const resolvedPreferred = new Set(evidence.filter((source) => source.verified === true)
    .map((source) => recordId(source?.recordId)).filter((id) => preferred.has(id)));
  const explicitComparison = preferred.size >= 2
    && /compar|difference/iu.test(searchInterpretation?.requestedFact ?? '');
  if ((supplied?.required !== true || explicitComparison)
    && preferred.size > 0 && resolvedPreferred.size === preferred.size) {
    return Object.freeze({
      required: false, kind: 'resolved_context', candidates: Object.freeze([]),
    });
  }
  if (decision?.decision !== 'CLARIFY') return supplied ?? null;
  // Several cited records alone cannot turn a clear overview into ambiguity.
  if (supplied?.required === false) return supplied;

  if (supplied?.required === true && supplied?.kind === 'unresolved_published_entity') {
    return Object.freeze({
      required: true, kind: supplied.kind, candidates: Object.freeze([]),
    });
  }

  const suppliedCandidates = new Set((supplied?.candidates ?? [])
    .map(candidateIdentity).filter(Boolean));
  const proposed = cleanList(decision.clarification?.candidates, 10);
  const resolved = [];
  const resolvedRecordIds = new Set();
  for (const candidate of proposed) {
    const normalized = candidateIdentity(candidate);
    if (!normalized || (suppliedCandidates.size && !suppliedCandidates.has(normalized))) continue;
    const matches = evidence.filter((source) => evidenceCandidateNames(source).includes(normalized));
    if (matches.length !== 1) continue;
    const matchedRecordId = recordId(matches[0].recordId);
    if (!matchedRecordId || resolvedRecordIds.has(matchedRecordId)) continue;
    resolvedRecordIds.add(matchedRecordId);
    resolved.push(candidate);
  }
  const confirmation = supplied?.kind === 'published_entity_confirmation'
    && resolvedRecordIds.size === 1;
  const genuine = resolvedRecordIds.size >= 2 || confirmation;
  return Object.freeze({
    required: genuine,
    kind: genuine ? cleanText(supplied?.kind, 80) || 'verified_candidates' : 'not_ambiguous',
    candidates: Object.freeze(genuine ? resolved : []),
  });
}

function restorePostSearchEvidenceIds(decision, aliasToEvidenceId) {
  const restored = decision.evidenceIds.map((alias) => aliasToEvidenceId.get(alias));
  if (restored.some((evidenceId) => !evidenceId)) {
    throw new AppError(500, 'A post-search citation alias could not be resolved',
      'TEMPLATE_ENGINE_EVIDENCE_ALIAS_INVALID');
  }
  return Object.freeze({
    ...decision,
    evidenceIds: Object.freeze(restored),
  });
}

function postSearchSchemaForDecision(schema, decision) {
  if (!decision) return schema;
  return Object.freeze({
    ...schema,
    properties: Object.freeze({
      ...schema.properties,
      decision: Object.freeze({ type: 'string', enum: Object.freeze([decision]) }),
    }),
  });
}

export async function respondToTemplateEngineSearch(input = {}, dependencies = {}) {
  if (dependencies.tenantBoundaryVerified !== true) {
    throw new AppError(500, 'The post-search tenant boundary is not verified',
      'TEMPLATE_ENGINE_POST_SEARCH_SCOPE_UNVERIFIED');
  }
  const base = createTemplateEngineOrchestratorInput({
    mainPrompt: input.mainPrompt,
    latestUtterance: input.latestUtterance,
    conversationHistory: input.state?.recentCompleteTurns ?? [],
    lastReferencedRecordIds: input.state?.lastReferencedRecordIds ?? [],
    comparisonRecordIds: input.state?.comparisonRecordIds ?? [],
    pendingClarification: input.state?.pendingClarification ?? null,
    activeWorkflowId: input.state?.activeWorkflowId ?? null,
    collectedToolFields: input.state?.collectedToolFields ?? {},
    confirmationStatus: input.state?.confirmationStatus ?? null,
    authorizedWorkflowTools: [],
    conversationGuidance: input.conversationGuidance,
  });
  const search = normalizeTemplateEngineSearchDecision(input.searchDecision, base.state);
  if (!search.valid || search.value.decision !== 'SEARCH') {
    throw new TypeError('The post-search Orchestrator requires a valid SEARCH interpretation');
  }
  const requiredEntityRecordIds = cleanList(input.requestedEntityRecordIds, 100);
  const evidence = evidenceForRequestedEntities(
    verifiedEvidenceForPostSearch(input.verifiedEvidence, input.scope),
    requiredEntityRecordIds,
  );
  const requestedFactAvailable = evidenceProvidesRequestedFact(
    evidence, search.value.search.requestedFact,
  );
  dependencies = { ...dependencies, maximumSpeechCharacters: input.maximumSpeechCharacters,
    ambiguity: verifiedClarificationAmbiguity(
    { decision: 'RESPONSE' }, evidence,
    { ...search.value.search, preferredRecordIds: requiredEntityRecordIds.length
      ? requiredEntityRecordIds : search.value.search.preferredRecordIds },
    dependencies.ambiguity,
  ) };
  const citations = aliasPostSearchEvidence(evidence);
  const verifiedEvidenceRecordIds = new Set(evidence.filter((source) => (
    source?.verified === true && source?.callerFacing !== false
  )).map((source) => cleanText(source.recordId, 160).toLocaleLowerCase()).filter(Boolean));
  const entityCoverageVerified = input.deterministicEntityCoverageVerified === true
    || (dependencies.ambiguity?.required !== true && evidence.length > 0
      && evidence.every((source) => source?.verified === true && source?.callerFacing !== false)
      && requiredEntityRecordIds.every((recordId) => verifiedEvidenceRecordIds.has(
        cleanText(recordId, 160).toLocaleLowerCase(),
      )));
  const allowedEvidenceIds = citations.aliases;
  const responseSchema = templateEnginePostSearchJsonSchemaForEvidenceAliases(
    allowedEvidenceIds,
  );
  const invokeStructuredLlm = dependencies.invokeStructuredLlm;
  if (typeof invokeStructuredLlm !== 'function') {
    throw new TypeError('The post-search Orchestrator requires one structured LLM invoker');
  }
  const answerContext = createTemplateEngineAnswerContext({
    evidence: citations.evidence, latestUtterance: base.latestUtterance,
    requestedFact: search.value.search.requestedFact,
    language: input.language,
    requestedEntityRecordIds: requiredEntityRecordIds,
    maximumSpeechCharacters: input.maximumSpeechCharacters,
    recentCompleteTurns: base.state.recentCompleteTurns,
    activeSubjectRecordIds: cleanText(search.value.search.contextualReference, 500)
      ? (requiredEntityRecordIds.length ? requiredEntityRecordIds
        : search.value.search.preferredRecordIds)
      : requiredEntityRecordIds,
  });
  const verifiedAnswerFastPath = input.deterministicResolutionVerified === true
    && input.deterministicEntityCoverageVerified === true
    && dependencies.ambiguity?.required !== true;
  const turnInput = Object.freeze({
    exactRequest: base.latestUtterance,
    callerLanguage: cleanText(input.language, 80) || null,
    speechBudget: Object.freeze({ maximumCharacters: input.maximumSpeechCharacters }),
    answerRequirements: answerContext.answerRequirements,
    conversationContext: answerContext.conversationContext,
    activeSubject: answerContext.activeSubject,
    safeUnavailableResponse: cleanText(input.informationUnavailableResponse, 4_000) || null,
    requestMeaning: input.requestMeaning ?? null,
    searchInterpretation: search.value.search,
    requestedEntityRecordIds: requiredEntityRecordIds,
    verifiedCandidates: Object.freeze(evidence.map((source, index) => Object.freeze({
      recordId: source.recordId,
      recordType: source.recordType,
      canonicalName: source.canonicalName ?? null,
      aliases: Object.freeze(cleanList(source.aliases, 20)),
      evidenceId: citations.evidence[index]?.evidenceId ?? null,
    }))),
    verifiedEvidence: answerContext.evidence,
    ...(verifiedAnswerFastPath ? {} : {
      latestUtterance: base.latestUtterance,
      ambiguity: dependencies.ambiguity ?? null,
      conversationGuidance: base.conversationGuidance,
    }),
  });
  const sharedGroundingInstructions = [
    'Runtime grounding rules: authoritativeData, content, and publishedAttributePaths contain the only published facts available for each record.',
    speechBudgetInstruction(input.maximumSpeechCharacters),
    firstPassAnswerInstruction,
    'Answer the current requestedFact directly from the supplied evidence. Preserve every requested comparison operand and cite each supporting record only in evidenceIds.',
    'Missing evidence never proves a negative claim. Answer supported parts and identify only the specific unpublished detail.',
    'Use conversationContext only to interpret conversational meaning and references. It is not factual evidence. activeSubject contains verified published identities for the current contextual request; factual claims must still come only from verifiedEvidence.',
    'When verifiedEvidence cannot support the requested information, return NO_MATCH with one natural, concise response in callerLanguage. Use safeUnavailableResponse when supplied, and never invent availability, policy, price, capability or contact details.',
  ];
  const detailedGroundingInstructions = [
    'For the fastest safe delivery, retain the published wording for factual names, attributes and values when it is natural in the caller language. Do not add synonymous factual claims that are absent from the evidence.',
    'Distinguish caller context from published facts. You may acknowledge a fact the caller stated, but it cannot establish eligibility, suitability, pricing or any business policy. For multi-part questions, answer the supported requested parts and identify the specific missing detail without inferring a negative or positive answer. Do not replace available information with a blanket NO_MATCH.',
    'Answer the requestedFact only when it is explicitly supported by those supplied facts.',
    'Preserve the original request in requestMeaning and latestUtterance. A search rewrite must not replace an overview with a single unrelated item or replace a focused attribute question with a full record recital. Answer the current request concisely using the cited records.',
    'Broad but clear requests require a useful summary, not clarification merely to reduce answer length. Ask one relevant clarification only when meaning is genuinely uncertain; do not invent candidates.',
    'A RESPONSE must directly answer searchInterpretation.requestedFact before adding any other supported information. A true answer about a different attribute is incomplete.',
    'An absent attribute means the published evidence does not provide that information. Absence never proves a negative value, non-existence, non-requirement, non-availability, or zero.',
    'For NO_MATCH, describe only that the requested information is not present in the supplied published evidence; do not assert that the underlying real-world attribute is false.',
    'CLARIFY speech must follow the supplied ambiguity object and must not introduce any unsupported factual claim.',
    'When ambiguity.required is true, generate only CLARIFY now, not an answer or NO_MATCH. A retrieved record is not proof that the caller meant that entity. Never assert equivalence between the caller wording and a published name without published alias evidence or a confirmed contextual reference.',
    'For multiple supplied published candidates, ask one question identifying those candidates. For one confirmation candidate, ask whether the caller meant it. For unresolved_published_entity with no candidates, ask one neutral clarification without inventing or naming an entity.',
    'When preferredRecordIds resolves one previously cited record, answer from that record; do not ask which record the caller means.',
    'When preferredRecordIds contains an intentional comparison set, compare those records; do not reinterpret the set as ambiguity.',
  ];
  const systemPrompt = [
    buildTemplateEngineGroundedAnswerPrompt({ mainPrompt: base.mainPrompt }),
    ...sharedGroundingInstructions,
    ...(verifiedAnswerFastPath ? [] : detailedGroundingInstructions),
    '<orchestrator_turn_input>',
    JSON.stringify(turnInput),
    '</orchestrator_turn_input>',
  ].join('\n');
  const baseMessages = Object.freeze([
    Object.freeze({ role: 'system', content: systemPrompt }),
    Object.freeze({ role: 'user', content: base.latestUtterance }),
  ]);
  const answerRequest = tagTemplateEngineTiming(Object.freeze({
    messages: baseMessages,
    temperature: 0,
    responseFormat: Object.freeze({
      type: 'json_schema',
      name: 'template_engine_post_search_decision',
      strict: true,
      schema: postSearchSchemaForDecision(responseSchema,
        dependencies.ambiguity?.required === true ? 'CLARIFY' : null),
    }),
  }), 'answer_generation');
  const answerGenerationCalls = 1;
  const completion = await invokeStructuredLlm(answerRequest);
  const output = completionOutput(completion);
  let validated = validateTemplateEnginePostSearchDecision(output, allowedEvidenceIds);
  if (dependencies.ambiguity?.required === true && validated.valid
    && validated.value.decision !== 'CLARIFY') {
    validated = { valid: false, reason: 'clarification_required_for_entity_resolution' };
  }
  const firstDiagnostics = templateEnginePostSearchDecisionDiagnostics(output);
  let firstInvalidReason = null;
  let configuredFallbackApplied = false;
  let extractiveRecoveryApplied = false;
  let budgetCompressionApplied = false;
  if (!validated.valid) {
    firstInvalidReason = validated.reason;
  }
  let finalDiagnostics = templateEnginePostSearchDecisionDiagnostics(output);
  if (!validated.valid) {
    const unavailableResponse = cleanText(input.informationUnavailableResponse, 4_000);
    const initialAmbiguity = verifiedClarificationAmbiguity(
      validated.valid ? validated.value : null,
      evidence, search.value.search, dependencies.ambiguity,
    );
    const extractiveRecovery = requestedFactAvailable
      && initialAmbiguity?.required !== true
      ? fullExtractiveGroundedRecovery(citations.evidence, search.value.search.requestedFact)
      : null;
    if (extractiveRecovery) {
      validated = validateTemplateEnginePostSearchDecision(
        extractiveRecovery, allowedEvidenceIds,
      );
      extractiveRecoveryApplied = validated.valid;
      if (validated.valid) {
        finalDiagnostics = templateEnginePostSearchDecisionDiagnostics(validated.value);
      }
    } else if (dependencies.ambiguity?.required !== true && evidence.length === 0 && unavailableResponse) {
      validated = validateTemplateEnginePostSearchDecision({
        decision: 'NO_MATCH', response: unavailableResponse,
        clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
      }, allowedEvidenceIds);
      configuredFallbackApplied = validated.valid;
      if (validated.valid) {
        finalDiagnostics = templateEnginePostSearchDecisionDiagnostics(validated.value);
      }
    }
  }
  if (!validated.valid) {
    if (typeof dependencies.onPostSearchDiagnostics === 'function') {
      dependencies.onPostSearchDiagnostics(Object.freeze({
        evidenceCount: evidence.length,
        allowedAliases: citations.aliases,
        returnedAliases: finalDiagnostics.evidenceAliases,
        initialValidationReason: firstInvalidReason,
        validationReason: validated.reason,
        finalDecision: finalDiagnostics.decision,
      }));
    }
    throw new AppError(502, 'The post-search Orchestrator returned an invalid decision',
      'TEMPLATE_ENGINE_POST_SEARCH_DECISION_INVALID', {
        reason: validated.reason,
        attempts: 1,
        first: firstDiagnostics,
        final: finalDiagnostics,
      });
  }
  let groundedDecision = restorePostSearchEvidenceIds(
    validated.value, citations.aliasToEvidenceId,
  );
  const validationInput = (decision, additions = {}) => outputValidationInput(
    decision, base, dependencies, {
      phase: 'post_search',
      factualClaimsPresent: true,
      selectedEvidence: evidence,
      searchInterpretation: input.requestMeaning?.kind === 'published_welcome_continuation'
        ? { ...search.value.search, requestedFact: 'details' }
        : search.value.search,
      ambiguity: verifiedClarificationAmbiguity(
        decision, evidence, search.value.search, dependencies.ambiguity,
      ),
      requiredEvidenceRecordIds: requiredEntityRecordIds.length
        ? requiredEntityRecordIds : base.state.comparisonRecordIds,
      requestedFactAvailable: !configuredFallbackApplied && requestedFactAvailable,
      ...additions,
    },
  );
  const deterministicPreflight = (decision, additions = {}) => {
    let validation = validateTemplateEngineOutput(validationInput(
      decision, { deterministicOnly: true, ...additions },
    ));
    if (validation.valid && decision.decision === 'RESPONSE') {
      if (!entityCoverageVerified) {
        validation = Object.freeze({ valid: false, ttsAllowed: false, route: 'REJECT',
          retrySearch: false, reason: 'requested_entity_coverage_not_verified' });
      }
      const citedIds = new Set(decision.evidenceIds ?? []);
      const cited = evidence.filter((source) => citedIds.has(source.evidenceId));
      const unsupportedTerms = unsupportedAcronyms(
        [decision.response, decision.nextQuestion?.question].filter(Boolean).join(' '), cited,
      );
      if (validation.valid && unsupportedTerms.length) {
        validation = Object.freeze({ valid: false, ttsAllowed: false, route: 'REJECT',
          retrySearch: false, reason: 'unsupported_factual_vocabulary',
          details: Object.freeze({ unsupportedTerms }) });
      }
    }
    return Object.freeze({ validation });
  };
  const initialPreflight = deterministicPreflight(groundedDecision);
  let outputValidation = initialPreflight.validation;
  let clarificationAmbiguity = verifiedClarificationAmbiguity(
    groundedDecision, evidence, search.value.search, dependencies.ambiguity,
  );
  let answerableEvidence = clarificationAmbiguity?.required !== true && (
    requestedFactAvailable || groundedDecision.decision === 'RESPONSE'
  );
  const initialNumericValidationDetails = outputValidation.reason === 'unsupported_numeric_claim'
    ? outputValidation.details : null;
  const budgetCompressionRequired = outputValidation.reason === 'speech_budget_exceeded';
  if (!outputValidation.valid && !firstInvalidReason) {
    firstInvalidReason = outputValidation.reason;
    // The one permitted generation call has completed. Recovery below is
    // extractive and deterministic; it never invokes another model.
  }
  if (budgetCompressionRequired && groundedDecision.nextQuestion) {
    const withoutOptionalFollowUp = Object.freeze({ ...groundedDecision, nextQuestion: null });
    const withoutFollowUpPreflight = deterministicPreflight(
      withoutOptionalFollowUp, { retryCount: 1 },
    );
    if (withoutFollowUpPreflight.validation.valid) {
      groundedDecision = withoutOptionalFollowUp;
      outputValidation = withoutFollowUpPreflight.validation;
      budgetCompressionApplied = true;
    }
  }
  if (!outputValidation.valid && outputValidation.reason === 'speech_budget_exceeded') {
    const shortenedDecision = shortenSupportedTemplateEngineDecision(
      groundedDecision, input.maximumSpeechCharacters,
    );
    if (shortenedDecision) {
      const shortenedPreflight = deterministicPreflight(shortenedDecision, { retryCount: 1 });
      if (shortenedPreflight.validation.valid) {
        groundedDecision = shortenedDecision;
        outputValidation = shortenedPreflight.validation;
        budgetCompressionApplied = true;
      }
    }
  }
  if (!outputValidation.valid) {
    const recoveryReason = outputValidation.reason;
    const unavailableResponse = cleanText(input.informationUnavailableResponse, 4_000);
    const extractiveRecovery = answerableEvidence && clarificationAmbiguity?.required !== true
      ? extractiveGroundedRecovery(citations.evidence, search.value.search.requestedFact, {
        maximumSpeechCharacters: recoveryReason === 'speech_budget_exceeded'
          ? input.maximumSpeechCharacters : null,
        requiredRecordIds: requiredEntityRecordIds.length
          ? requiredEntityRecordIds : base.state.comparisonRecordIds,
      })
      : null;
    if (extractiveRecovery) {
      const recovered = validateTemplateEnginePostSearchDecision(
        extractiveRecovery, allowedEvidenceIds,
      );
      if (recovered.valid) {
        extractiveRecoveryApplied = true;
        budgetCompressionApplied = recoveryReason === 'speech_budget_exceeded';
        groundedDecision = restorePostSearchEvidenceIds(
          recovered.value, citations.aliasToEvidenceId,
        );
        const extractivePreflight = deterministicPreflight(groundedDecision, { retryCount: 1 });
        outputValidation = extractivePreflight.validation;
        finalDiagnostics = templateEnginePostSearchDecisionDiagnostics(recovered.value);
      }
    } else if (!budgetCompressionRequired && clarificationAmbiguity?.required !== true
      && evidence.length === 0 && unavailableResponse) {
      const noMatch = validateTemplateEnginePostSearchDecision({
        decision: 'NO_MATCH', response: unavailableResponse,
        clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
      }, allowedEvidenceIds);
      if (noMatch.valid) {
        configuredFallbackApplied = true;
        groundedDecision = restorePostSearchEvidenceIds(
          noMatch.value, citations.aliasToEvidenceId,
        );
        const noMatchPreflight = deterministicPreflight(groundedDecision, {
          requestedFactAvailable: false, retryCount: 1,
        });
        outputValidation = noMatchPreflight.validation;
        configuredFallbackApplied = outputValidation.valid;
        finalDiagnostics = templateEnginePostSearchDecisionDiagnostics(noMatch.value);
      }
    }
  }
  if (!outputValidation.valid) {
    if (typeof dependencies.onPostSearchDiagnostics === 'function') {
      dependencies.onPostSearchDiagnostics(Object.freeze({
        evidenceCount: evidence.length,
        allowedAliases: citations.aliases,
        returnedAliases: finalDiagnostics.evidenceAliases,
        initialValidationReason: firstInvalidReason,
        initialNumericValidationDetails,
        finalNumericValidationDetails: outputValidation.details ?? null,
        validationReason: outputValidation.reason,
        finalDecision: outputValidation.retrySearch ? 'SEARCH' : groundedDecision.decision,
      }));
    }
    throw new AppError(502, 'The post-search output failed delivery validation',
      'TEMPLATE_ENGINE_OUTPUT_INVALID', { reason: outputValidation.reason,
        initialNumericValidationDetails,
        validationDetails: outputValidation.details ?? null,
        contextualMemoryVerified: input.contextualMemoryVerified === true,
        requestedEntityRecordIds: requiredEntityRecordIds });
  }
  const diagnostics = Object.freeze({
    evidenceCount: evidence.length,
    allowedAliases: citations.aliases,
    returnedAliases: finalDiagnostics.evidenceAliases,
    initialValidationReason: firstInvalidReason,
    validationReason: null,
    finalDecision: groundedDecision.decision,
    deterministicRecoveryApplied: extractiveRecoveryApplied || configuredFallbackApplied,
    extractiveRecoveryApplied,
    configuredFallbackApplied,
    providerFailureRecoveryApplied: configuredFallbackApplied,
    budgetCompressionApplied,
    initialNumericValidationDetails,
    verifiedAnswerFastPath,
    answerGenerationCalls,
  });
  if (typeof dependencies.onPostSearchDiagnostics === 'function') {
    dependencies.onPostSearchDiagnostics(diagnostics);
  }
  return Object.freeze({
    decision: groundedDecision,
    input: turnInput,
    outputValidation,
    diagnostics,
  });
}
