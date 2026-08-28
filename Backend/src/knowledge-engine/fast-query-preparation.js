import { createKnowledgeEngineInput } from './engine-contract.js';
import {
  buildPublicationPhraseForms,
  normalizePublicationPhrase,
} from './publication-index-builder.js';
import { resolvePublishedEntityRoute } from './entity-route-resolver.js';
import { classifyKnowledgeQuery, knowledgeQueryClasses } from './query-classifier.js';
import { understandContextualKnowledgeQuery } from './contextual-query-understanding.js';
import { resolveKnowledgeConfidenceConfiguration } from '../knowledge-bases/knowledge-confidence-config.js';

export const FAST_QUERY_PREPARATION_VERSION = 2;

function unique(values) {
  return Object.freeze([...new Set(values.filter(Boolean))]);
}

function enrichedInput(input, requestedFacts, contextualReferences, queryUnderstanding = null) {
  return createKnowledgeEngineInput({
    tenantId: input.tenantId,
    agentId: input.agentId,
    callId: input.callId,
    utterance: input.latestQuestion ?? input.utterance,
    usageDirection: input.usageDirection,
    language: input.language,
    requestedFacts,
    contextualReferences,
    recentRelevantTurns: input.recentRelevantTurns,
    memory: input.canonicalCallMemory ?? input.memory,
    queryUnderstanding,
    abortSignal: input.abortSignal,
  });
}

export async function prepareKnowledgeQuery(input, publicationBundles, options = {}, dependencies = {}) {
  if (!input?.tenantId || !input?.agentId || !input?.callId || !input?.utterance) {
    throw new TypeError('Fast query preparation requires a finalized knowledge-engine input');
  }
  const normalizedQuestion = normalizePublicationPhrase(input.latestQuestion ?? input.utterance);
  const initialInput = enrichedInput(
    input,
    unique([...(input.requestedFacts ?? [])]),
    unique([...(input.contextualReferences ?? [])]),
  );
  const resolve = dependencies.resolve ?? resolvePublishedEntityRoute;
  const understand = dependencies.understand ?? understandContextualKnowledgeQuery;
  const classify = dependencies.classify ?? classifyKnowledgeQuery;
  const initialResolution = await resolve(initialInput, publicationBundles, {
    semanticMatches: options.semanticMatches ?? [],
    confidenceConfiguration: options.confidenceConfiguration,
  });
  const understanding = await understand(initialInput, initialResolution);
  const preparedInput = enrichedInput(
    input, understanding.requestedFacts, understanding.contextualReferences, understanding,
  );
  const resolution = Object.freeze({
    ...initialResolution,
    contextDependent: understanding.contextDependent === true,
    contextualEntity: understanding.contextDependent ? understanding.canonicalContext : null,
  });
  const classification = await classify(preparedInput, resolution);
  const priorityIntent = [
    knowledgeQueryClasses.SAFETY_EMERGENCY,
    knowledgeQueryClasses.CALL_CONTROL,
  ].includes(classification.intentClass);
  return Object.freeze({
    version: FAST_QUERY_PREPARATION_VERSION,
    input: preparedInput,
    normalizedQuestion,
    queryForms: buildPublicationPhraseForms([preparedInput.latestQuestion]),
    requestedFact: preparedInput.requestedFact,
    requestedFacts: preparedInput.requestedFacts,
    contextualReferences: preparedInput.contextualReferences,
    understanding,
    intentClass: classification.intentClass,
    priorityIntent,
    usesCallMemory: understanding.contextDependent === true,
    resolution,
    classification,
  });
}

export async function refineKnowledgeResolution(
  input, publicationBundles, currentResolution, classification, semanticMatches = [], dependencies = {},
) {
  if (!Array.isArray(semanticMatches) || semanticMatches.length === 0) return currentResolution;
  const confidenceConfiguration = resolveKnowledgeConfidenceConfiguration(
    currentResolution?.confidenceConfiguration,
  );
  const selected = classification?.candidate ?? currentResolution?.candidate;
  // Semantic search may recover an unresolved turn, but it must not replace a
  // high-confidence entity or route resolved from published tenant metadata.
  if (selected?.explicit === true
    && Number(selected.score ?? currentResolution?.score ?? 0)
      >= confidenceConfiguration.highConfidence) {
    return currentResolution;
  }
  const resolve = dependencies.resolve ?? resolvePublishedEntityRoute;
  // A weak lexical match must not constrain semantic recovery to its namespace.
  // Every candidate is already publication-scoped; the resolver applies final
  // namespace and explicit-entity priority across the independent results.
  return resolve(input, publicationBundles, {
    semanticMatches,
    confidenceConfiguration,
  });
}
