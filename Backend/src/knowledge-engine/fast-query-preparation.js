import { createKnowledgeEngineInput } from './engine-contract.js';
import {
  buildPublicationPhraseForms,
  normalizePublicationPhrase,
} from './publication-index-builder.js';
import { resolvePublishedEntityRoute } from './entity-route-resolver.js';
import { classifyKnowledgeQuery, knowledgeQueryClasses } from './query-classifier.js';

export const FAST_QUERY_PREPARATION_VERSION = 1;

const contextualReferencePhrases = Object.freeze([
  'this', 'that', 'it', 'these', 'those', 'same',
  'this one', 'that one', 'this option', 'that option',
  'ithu', 'idhu', 'ithula', 'idhula', 'ithoda', 'idhoda',
  'adhu', 'athu', 'athula', 'athoda',
  'இது', 'இதில்', 'இதுல', 'இதோட', 'இந்த',
  'அது', 'அதில்', 'அதுல', 'அதோட', 'அந்த',
]);

const requestedFactPhrases = Object.freeze({
  price: Object.freeze([
    'price', 'cost', 'rate', 'amount', 'how much',
    'விலை', 'எவ்வளவு', 'evlo', 'evalavu', 'evvalavu',
  ]),
  details: Object.freeze([
    'detail', 'details', 'information', 'tell me about', 'include', 'includes',
    'included', 'tests', 'services', 'benefits', 'விவரம்', 'என்ன இருக்கு',
    'enna irukku', 'enna tests',
  ]),
  availability: Object.freeze([
    'available', 'availability', 'in stock', 'இருக்கா', 'கிடைக்குமா',
    'irukka', 'kidaikkuma',
  ]),
  preparation: Object.freeze([
    'prepare', 'preparation', 'fasting', 'before the', 'தயாராக', 'நோன்பு',
    'fasting venuma',
  ]),
  comparison: Object.freeze([
    'compare', 'comparison', 'difference', 'different', 'versus', ' vs ',
    'வேறுபாடு', 'difference enna',
  ]),
});

function unique(values) {
  return Object.freeze([...new Set(values.filter(Boolean))]);
}

function phrasePresent(query, phrase) {
  const normalized = normalizePublicationPhrase(phrase);
  return normalized && ` ${query} `.includes(` ${normalized} `);
}

export function extractContextualReferences(question) {
  const query = normalizePublicationPhrase(question);
  return unique(contextualReferencePhrases.filter((phrase) => phrasePresent(query, phrase)));
}

export function extractRequestedFacts(question) {
  const query = normalizePublicationPhrase(question);
  return Object.freeze(Object.entries(requestedFactPhrases).flatMap(([fact, phrases]) => (
    phrases.some((phrase) => phrasePresent(query, phrase)) ? [fact] : []
  )));
}

function enrichedInput(input, requestedFacts, contextualReferences) {
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
    abortSignal: input.abortSignal,
  });
}

export async function prepareKnowledgeQuery(input, publicationBundles, options = {}, dependencies = {}) {
  if (!input?.tenantId || !input?.agentId || !input?.callId || !input?.utterance) {
    throw new TypeError('Fast query preparation requires a finalized knowledge-engine input');
  }
  const normalizedQuestion = normalizePublicationPhrase(input.latestQuestion ?? input.utterance);
  const requestedFacts = unique([
    ...(input.requestedFacts ?? []),
    ...extractRequestedFacts(normalizedQuestion),
  ]);
  const contextualReferences = unique([
    ...(input.contextualReferences ?? []),
    ...extractContextualReferences(normalizedQuestion),
  ]);
  const preparedInput = enrichedInput(input, requestedFacts, contextualReferences);
  const resolve = dependencies.resolve ?? resolvePublishedEntityRoute;
  const classify = dependencies.classify ?? classifyKnowledgeQuery;
  const resolution = await resolve(preparedInput, publicationBundles, {
    semanticMatches: options.semanticMatches ?? [],
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
    intentClass: classification.intentClass,
    priorityIntent,
    usesCallMemory: contextualReferences.length > 0 && resolution.explicitEntity !== true,
    resolution,
    classification,
  });
}

export async function refineKnowledgeResolution(
  input, publicationBundles, currentResolution, classification, semanticMatches = [], dependencies = {},
) {
  if (!Array.isArray(semanticMatches) || semanticMatches.length === 0) return currentResolution;
  const selected = classification?.candidate ?? currentResolution?.candidate;
  // Semantic search may recover an unresolved turn, but it must not replace a
  // resolved FAQ, Conversation, Workflow or Catalog route with another type.
  if (selected?.explicit === true && Number(selected.score ?? currentResolution?.score ?? 0) >= 0.88) {
    return currentResolution;
  }
  const expectedTypes = Object.freeze({
    CATALOG: new Set(['CATALOG_ITEM', 'CATALOG_CATEGORY']),
    FAQ: new Set(['FAQ']), CONVERSATION: new Set(['CONVERSATION_NODE']),
    WORKFLOW: new Set(['WORKFLOW_RULE']), GENERAL: new Set(['KNOWLEDGE_CHUNK']),
  })[classification?.selectedNamespace ?? currentResolution?.candidateNamespace];
  const scopedSemanticMatches = expectedTypes
    ? semanticMatches.filter((candidate) => expectedTypes.has(String(candidate.recordType ?? '').toUpperCase()))
    : semanticMatches;
  if (!scopedSemanticMatches.length) return currentResolution;
  const resolve = dependencies.resolve ?? resolvePublishedEntityRoute;
  return resolve(input, publicationBundles, { semanticMatches: scopedSemanticMatches });
}
