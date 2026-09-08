import { createKnowledgeEngineInput } from '../../knowledge-engine/engine-contract.js';
import { canonicalRecordIdentityKey } from '../../knowledge-engine/canonical-record-identity.js';
import { rankAndHydrateAuthoritativeEvidence } from '../../knowledge-engine/authoritative-evidence.js';
import { AppError } from '../../middleware/errors.js';
import { knowledgeSearchIndexes } from '../../knowledge-engine/query-classifier.js';
import { loadPublishedEngineArtifacts } from '../../knowledge-engine/runtime-service.js';
import { searchParallelHybridCandidates } from '../../knowledge-bases/parallel-hybrid-search.js';
import { publishedRecordCallerFacingHint } from '../../knowledge-engine/evidence-audience.js';
import { buildPublicationDeduplicationIdentity } from '../../knowledge-engine/publication-deduplication.js';
import { runTemplateEngineHybridRetrieval } from './template-engine-hybrid-retrieval.js';
import { normalizePublishedConversationGuidance } from './template-engine-conversation-guidance.js';
import { resolvePublishedEntityRoute } from '../../knowledge-engine/entity-route-resolver.js';
import { normalizeTemplateEngineSearchDecision } from './template-engine-search-request.js';
import { publishedNameText } from './published-name-text.js';

export const TEMPLATE_ENGINE_PRODUCTION_RETRIEVAL_VERSION = 1;

const namespaces = Object.freeze(['CATALOG', 'FAQ', 'GENERAL', 'CONVERSATION', 'WORKFLOW']);
const indexes = Object.freeze([
  knowledgeSearchIndexes.CATALOG,
  knowledgeSearchIndexes.FAQ,
  knowledgeSearchIndexes.GENERAL,
  knowledgeSearchIndexes.CONVERSATION,
  knowledgeSearchIndexes.WORKFLOW,
  knowledgeSearchIndexes.BM25,
  knowledgeSearchIndexes.SEMANTIC,
]);

function cleanText(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function textList(values, maximum = 80) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanText(value, 500)).filter(Boolean))].slice(0, maximum);
}

function recordMetadata(record) {
  const value = record?.entity_metadata ?? record?.entityMetadata ?? record?.metadata;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function searchableTokens(value) {
  return [...new Set(cleanText(value, 4_000).toLocaleLowerCase()
    .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])];
}

function publishedFormScore(query, forms) {
  const queryText = cleanText(publishedNameText(query), 4_000).toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  const queryTokens = new Set(searchableTokens(queryText));
  let best = 0;
  for (const form of forms) {
    const formText = cleanText(publishedNameText(form), 500).toLocaleLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
    const formTokens = searchableTokens(formText);
    if (!formText || !formTokens.length) continue;
    if (queryText === formText) best = Math.max(best, 1);
    else if (` ${queryText} `.includes(` ${formText} `)) best = Math.max(best, 0.98);
    else {
      const matched = formTokens.filter((token) => queryTokens.has(token)).length;
      const coverage = matched / formTokens.length;
      const sufficient = formTokens.length === 1
        ? matched === 1 && formText.length >= 4
        : matched >= 2 && coverage >= 0.6;
      if (sufficient) best = Math.max(best, 0.72 + (coverage * 0.22));
    }
  }
  return best;
}

function publishedRecordCandidate(record, bundle, input, overrides = {}) {
  const metadata = recordMetadata(record);
  const recordId = cleanText(record?.record_id ?? record?.recordId ?? record?.id, 160);
  const recordType = cleanText(
    overrides.recordType ?? record?.record_type ?? record?.recordType ?? record?.type, 80,
  ).toUpperCase();
  if (!recordId || !recordType) return null;
  return Object.freeze({
    tenantId: input.tenantId,
    agentId: input.agentId,
    knowledgeBaseId: cleanText(bundle.knowledgeBaseId, 160),
    publicationRevision: Number(bundle.publicationRevision),
    recordId,
    recordType,
    score: Number(overrides.score ?? 1),
    namespaceRank: 1,
    callerFacingHint: publishedRecordCallerFacingHint(record),
    authorizationHint: false,
    deduplicationIdentity: buildPublicationDeduplicationIdentity(record, {
      tenantId: input.tenantId,
      knowledgeBaseId: bundle.knowledgeBaseId,
      publicationRevision: bundle.publicationRevision,
    }),
    canonicalName: cleanText(overrides.canonicalName
      ?? record.entity_name ?? record.entity_category ?? record.question
      ?? metadata.name ?? metadata.category, 300) || null,
    itemKey: cleanText(
      overrides.itemKey ?? record.itemKey ?? record.item_key
      ?? metadata.itemKey ?? metadata.item_key, 160,
    ) || null,
    categoryKey: cleanText(
      overrides.categoryKey ?? record.categoryKey ?? record.category_key
      ?? metadata.categoryKey ?? metadata.category_key, 160,
    ) || null,
    searchForms: Object.freeze(textList(overrides.searchForms ?? [
      record.entity_name, record.entity_category, record.question,
      ...(record.publicationAliases ?? record.entity_aliases ?? []),
      ...(record.publicationSttForms ?? []),
      ...(record.publicationPhoneticForms ?? []),
    ])),
    tokenCoverage: Number(overrides.score ?? 1),
    matchMethod: cleanText(overrides.matchMethod ?? 'published_exact', 100),
    ...(Array.isArray(overrides.evidenceRecordIds) ? {
      evidenceRecordIds: Object.freeze([...new Set(overrides.evidenceRecordIds)]),
    } : {}),
  });
}

function publishedReferenceSelectors(values = []) {
  return textList(values, 100).flatMap((value) => value.split(/\s*\|\s*/u)).flatMap((value) => {
    const [label, reference = ''] = value.split(/\s*=>\s*/u, 2);
    const separator = reference.indexOf(':');
    const type = separator >= 0 ? normalized(reference.slice(0, separator)) : null;
    const key = separator >= 0 ? normalized(reference.slice(separator + 1)) : normalized(reference);
    return key ? [Object.freeze({ label: normalized(label), type, key })] : [];
  });
}

function publicationCategoryVocabulary(bundle, usageDirection) {
  const categories = new Map();
  for (const record of bundle.records ?? []) {
    if (!['both', normalized(usageDirection)].includes(normalized(record.usage_direction ?? record.usageDirection ?? 'both'))) continue;
    const metadata = recordMetadata(record);
    const key = normalized(record.categoryKey ?? record.category_key ?? metadata.categoryKey ?? metadata.category_key);
    if (!key) continue;
    const categoryRecord = normalized(record.record_type ?? record.recordType) === 'catalog_category';
    const forms = textList([record.entity_category, metadata.category,
      ...(record.entity_category_aliases ?? []), ...(metadata.categoryAliases ?? []),
      ...(metadata.categorySttForms ?? []), ...(metadata.crossDocumentCategoryAliases ?? []),
      ...(categoryRecord ? [record.entity_name, metadata.name,
        ...(record.entity_aliases ?? []), ...(metadata.aliases ?? []), ...(record.publicationAliases ?? [])] : []),
    ]);
    categories.set(key, textList([...(categories.get(key) ?? []), ...forms]));
  }
  return categories;
}

export function exactPublishedCandidates(
  artifacts, input, search, limit = 20, guidance = null, publicationIndex = null,
) {
  const candidates = [];
  const categoryMatches = new Map();
  const guidanceRecordId = normalized(guidance?.recordId);
  const referenceSelectors = publishedReferenceSelectors(guidance?.catalogReferences);
  for (const bundle of artifacts.bundles ?? []) {
    if (normalized(bundle?.tenantId) !== normalized(input.tenantId)) continue;
    const bundleKey = `${normalized(bundle.knowledgeBaseId)}:${Number(bundle.publicationRevision)}`;
    const categoryVocabulary = publicationIndex?.categoryVocabularyByPublication?.[bundleKey]
      ?? publicationCategoryVocabulary(bundle, input.usageDirection);
    for (const record of bundle.records ?? []) {
      const metadata = recordMetadata(record);
      const recordType = cleanText(
        record.record_type ?? record.recordType ?? record.type, 80,
      ).toUpperCase();
      const usage = cleanText(record.usage_direction ?? record.usageDirection ?? 'both', 20)
        .toLocaleLowerCase();
      if (!['both', cleanText(input.usageDirection, 20).toLocaleLowerCase()].includes(usage)) continue;
      const itemForms = textList([
        record.entity_name, record.canonicalName, metadata.name,
        record.itemKey, record.item_key,
        metadata.itemKey, metadata.item_key,
        ...(record.entity_aliases ?? []),
        ...textList(metadata.aliases),
        ...textList(metadata.sttForms),
        ...textList(metadata.phoneticForms),
        ...(metadata.crossDocumentAliases ?? []),
        ...(record.publicationAliases ?? []),
        ...(record.publicationSttForms ?? []),
        ...(record.publicationPhoneticForms ?? []),
      ]);
      const categoryForms = textList([
        ...(categoryVocabulary.get(normalized(record.categoryKey ?? record.category_key
          ?? metadata.categoryKey ?? metadata.category_key)) ?? []),
        record.entity_category, metadata.category, record.categoryKey, record.category_key,
        metadata.categoryKey, metadata.category_key,
        ...(record.entity_category_aliases ?? []),
        ...(metadata.categoryAliases ?? []),
        ...(metadata.categorySttForms ?? []),
        ...(metadata.categoryPhoneticForms ?? []),
        ...(metadata.crossDocumentCategoryAliases ?? []),
      ]);
      const routeForms = textList([
        record.question, record.entity_name, record.content,
        metadata.nodeKey, metadata.purpose, metadata.situation,
        ...(record.publicationAliases ?? record.entity_aliases ?? []),
        ...(record.publicationSttForms ?? []),
        ...(record.publicationPhoneticForms ?? []),
      ]);
      const directForms = recordType === 'CATALOG_ITEM' ? itemForms
        : recordType === 'CATALOG_CATEGORY' ? [...itemForms, ...categoryForms] : routeForms;
      const directScore = publishedFormScore(search.query, directForms);
      const recordId = normalized(record.record_id ?? record.recordId ?? record.id);
      const exactGuidance = guidanceRecordId && recordId === guidanceRecordId;
      const itemReference = referenceSelectors.some((reference) => (
        reference.type === 'item' && (
          reference.key === normalized(metadata.itemKey ?? metadata.item_key)
          || reference.label === normalized(record.entity_name)
        )
      ));
      if (directScore > 0 || exactGuidance || itemReference) {
        const candidate = publishedRecordCandidate(record, bundle, input, {
          score: exactGuidance ? 1 : itemReference ? 0.99 : directScore,
          searchForms: directForms,
          matchMethod: exactGuidance ? 'published_guidance_exact'
            : itemReference ? 'published_reference_exact'
              : directScore >= 0.98 ? 'published_exact' : 'published_partial',
        });
        if (candidate) candidates.push(candidate);
      }
      if (recordType !== 'CATALOG_ITEM') continue;
      const categoryReference = referenceSelectors.some((reference) => (
        reference.type === 'category' && (
          reference.key === normalized(metadata.categoryKey ?? metadata.category_key)
          || reference.label === normalized(record.entity_category)
        )
      ));
      const categoryScore = categoryReference ? 0.99
        : publishedFormScore(search.query, categoryForms);
      const categoryKey = cleanText(
        record.categoryKey ?? record.category_key
        ?? metadata.categoryKey ?? metadata.category_key, 160,
      );
      const anchorRecordId = cleanText(record.record_id ?? record.recordId ?? record.id, 160);
      if (!categoryScore || !categoryKey || !anchorRecordId) continue;
      const key = `${normalized(bundle.knowledgeBaseId)}:${bundle.publicationRevision}:${normalized(categoryKey)}`;
      const aggregate = categoryMatches.get(key) ?? {
        bundle, record, categoryKey, score: categoryScore, recordIds: [], categoryForms,
      };
      aggregate.score = Math.max(aggregate.score, categoryScore);
      aggregate.recordIds.push(anchorRecordId);
      categoryMatches.set(key, aggregate);
    }
  }
  for (const aggregate of categoryMatches.values()) {
    const metadata = recordMetadata(aggregate.record);
    const candidate = publishedRecordCandidate(aggregate.record, aggregate.bundle, input, {
      recordType: 'CATALOG_CATEGORY',
      canonicalName: aggregate.record.entity_category ?? metadata.category,
      categoryKey: aggregate.categoryKey,
      score: aggregate.score,
      searchForms: aggregate.categoryForms,
      matchMethod: referenceSelectors.some((reference) => (
        reference.type === 'category'
        && reference.key === normalized(aggregate.categoryKey)
      )) ? 'published_reference_exact' : 'published_category_exact',
      evidenceRecordIds: aggregate.recordIds.filter(Boolean),
    });
    if (candidate) candidates.push(candidate);
  }
  return Object.freeze([...new Map(candidates.sort((left, right) => right.score - left.score)
    .map((candidate) => [`${candidate.recordType}:${normalized(candidate.recordId)}`, candidate]))
    .values()].slice(0, limit));
}

function candidateRequestedRecordIds(candidate) {
  const categoryRecords = candidate?.recordType === 'CATALOG_CATEGORY'
    && Array.isArray(candidate.evidenceRecordIds) ? candidate.evidenceRecordIds : [];
  return [...new Set((categoryRecords.length ? categoryRecords : [candidate?.recordId])
    .map((value) => cleanText(value, 160)).filter(Boolean))].sort();
}

function normalizedPublishedForm(value) {
  return cleanText(publishedNameText(value), 500).toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function strongestContainedPublishedForm(candidate, utterance) {
  const source = ` ${normalizedPublishedForm(utterance)} `;
  return (candidate?.searchForms ?? []).map(normalizedPublishedForm).filter((form) => (
    form && source.includes(` ${form} `)
  )).sort((left, right) => {
    const tokenDifference = searchableTokens(right).length - searchableTokens(left).length;
    return tokenDifference || right.length - left.length;
  })[0] ?? null;
}

function uniqueCandidateIdentities(candidates, utterance) {
  const identities = new Map();
  for (const candidate of candidates) {
    const requestedRecordIds = candidateRequestedRecordIds(candidate);
    const matchedForm = strongestContainedPublishedForm(candidate, utterance);
    if (!requestedRecordIds.length || !matchedForm) continue;
    const identity = [
      normalized(candidate.knowledgeBaseId), Number(candidate.publicationRevision),
      candidate.recordType, requestedRecordIds.join('|'),
    ].join(':');
    const current = identities.get(identity);
    if (!current || searchableTokens(matchedForm).length
      > searchableTokens(current.matchedForm).length) {
      identities.set(identity, { candidate, requestedRecordIds, matchedForm });
    }
  }
  return identities;
}

function deterministicFactualRequestKind(value) {
  const text = cleanText(value, 2_000).toLocaleLowerCase();
  // Keep non-Latin request markers escaped so source/editor encoding cannot
  // silently disable the deterministic path in production.
  if (/(?:\u0BB5\u0BBF\u0BA4\u0BCD\u0BA4\u0BBF\u0BAF\u0BBE\u0B9A|\u0B92\u0BAA\u0BCD\u0BAA\u0BBF\u0B9F)/u.test(text)) {
    return 'comparison';
  }
  if (/(?:\u0BB5\u0BBF\u0BB2\u0BC8|\u0B8E\u0BB5\u0BCD\u0BB5\u0BB3|\u0B95\u0B9F\u0BCD\u0B9F\u0BA3)/u.test(text)) {
    return 'fact';
  }
  if (/(?:\u0B8E\u0BA9\u0BCD\u0BA9\u0BC6\u0BA9\u0BCD\u0BA9|\u0B8E\u0BA8\u0BCD\u0BA4\u0BC6\u0BA8\u0BCD\u0BA4|\u0B95\u0BBF\u0B9F\u0BC8\u0B95\u0BCD\u0B95|\u0BB5\u0BBF\u0BB0\u0BC1\u0BAA\u0BCD\u0BAA|\u0BAA\u0BB1\u0BCD\u0BB1\u0BBF|\u0BB5\u0BBF\u0BB5\u0BB0|\u0B9A\u0BCA\u0BB2\u0BCD\u0BB2)/u.test(text)) {
    return 'fact';
  }
  if (/(?:\b(?:compare|comparison|difference|different|versus|vs)\b|வித்தியாச|ஒப்பிட)/iu.test(text)) {
    return 'comparison';
  }
  if (/(?:\b(?:price|cost|rate|fee|charge|amount|how much)\b|விலை|எவ்வள|கட்டணம்)/iu.test(text)) {
    return 'fact';
  }
  if (/(?:\b(?:which|what|available|options|list|detail|details|explain|tell|about|include|includes)\b|என்னென்ன|எந்தெந்த|கிடைக்க|விருப்ப|பற்றி|விவர|சொல்லு|என்ன வரும்)/iu.test(text)) {
    return 'fact';
  }
  return null;
}

/**
 * Resolve only identities proved by complete published names or aliases.
 * Natural wrapper words may surround those identities. Multiple independently
 * named items form a comparison set; one shared alias that maps to multiple
 * records remains ambiguous and therefore stays on the semantic router.
 */
export function deterministicPublishedRequestDecision({
  artifacts, scope, usageDirection = 'both', latestUtterance,
} = {}) {
  const utterance = cleanText(latestUtterance, 2_000);
  if (!utterance || !scope?.tenantId) return null;
  const activePublications = new Set((scope.publications ?? []).map((publication) => (
    `${normalized(publication?.knowledgeBaseId)}:${Number(publication?.publicationRevision)}`
  )).filter((key) => !key.startsWith(':') && !key.endsWith(':0')));
  if (!activePublications.size) return null;
  const scopedArtifacts = {
    ...(artifacts ?? {}),
    bundles: (artifacts?.bundles ?? []).filter((bundle) => {
      const publicationKey = `${normalized(bundle?.knowledgeBaseId)}:${Number(bundle?.publicationRevision)}`;
      const assigned = Array.isArray(bundle?.assignedAgentIds) ? bundle.assignedAgentIds : [];
      return activePublications.has(publicationKey)
        && (!scope.agentId || !assigned.length
          || assigned.some((id) => normalized(id) === normalized(scope.agentId)));
    }),
  };
  const publishedMatches = exactPublishedCandidates(scopedArtifacts, {
    tenantId: scope.tenantId,
    agentId: scope.agentId,
    usageDirection,
  }, { query: utterance }, 50);
  if (publishedMatches.some((candidate) => (
    candidate.recordType === 'WORKFLOW_RULE' && Number(candidate.score) >= 0.98
  ))) return null;
  const exact = publishedMatches.filter((candidate) => (
    Number(candidate.score) >= 0.98
    && ['CATALOG_ITEM', 'CATALOG_CATEGORY', 'FAQ', 'CONVERSATION_NODE'].includes(
      candidate.recordType,
    )
    && ['published_exact', 'published_category_exact'].includes(candidate.matchMethod)
  ));
  if (!exact.length) return null;

  // A materialized category aggregate is stronger than its optional category
  // heading record. Explicit items outrank their surrounding category name.
  const exactItems = exact.filter((candidate) => candidate.recordType === 'CATALOG_ITEM');
  const aggregateCategories = exact.filter((candidate) => (
    candidate.recordType === 'CATALOG_CATEGORY'
    && Array.isArray(candidate.evidenceRecordIds)
    && candidate.evidenceRecordIds.length > 0
  ));
  const exactCatalog = exact.filter((candidate) => (
    ['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(candidate.recordType)
  ));
  const exactRoutes = exact.filter((candidate) => (
    ['FAQ', 'CONVERSATION_NODE'].includes(candidate.recordType)
  ));
  const eligible = exactItems.length ? exactItems
    : aggregateCategories.length ? aggregateCategories
      : exactCatalog.length ? exactCatalog : exactRoutes;
  const identities = uniqueCandidateIdentities(eligible, utterance);
  if (!identities.size) return null;
  const selections = [...identities.values()];
  const itemComparison = selections.length > 1
    && selections.every(({ candidate }) => candidate.recordType === 'CATALOG_ITEM');
  if (selections.length > 1 && !itemComparison) return null;
  const requestKind = deterministicFactualRequestKind(utterance);
  if (itemComparison && requestKind !== 'comparison') return null;
  if (itemComparison && new Set(selections.map(({ matchedForm }) => matchedForm)).size
    !== selections.length) return null;
  if (!itemComparison && Number(selections[0].candidate.score) < 1 && !requestKind) return null;
  const [{ candidate }] = selections;
  const requestedRecordIds = itemComparison
    ? [...new Set(selections.flatMap((selection) => selection.requestedRecordIds))].sort()
    : selections[0].requestedRecordIds;
  return Object.freeze({
    decision: 'SEARCH', response: '', clarification: null,
    search: Object.freeze({
      query: utterance,
      requestedFact: utterance,
      contextualReference: null,
      // Supplying all category children as preferred IDs would incorrectly
      // classify the category as a comparison. Its exact category match
      // carries that identity; individual items reserve their one record.
      preferredRecordIds: Object.freeze(
        ['CATALOG_ITEM', 'FAQ', 'CONVERSATION_NODE'].includes(candidate.recordType)
          ? requestedRecordIds : [],
      ),
    }),
    tool: null, nextQuestion: null, stateUpdate: null,
  });
}

const contextualReferenceTokens = new Set([
  'it', 'its', 'this', 'that', 'these', 'those', 'them', 'their',
  'அது', 'அதுல', 'அதில்', 'அதை', 'அதன்', 'அதுக்கு',
  'இது', 'இதுல', 'இதில்', 'இதை', 'இதன்', 'இதுக்கு', 'அவை', 'இவை',
  'athu', 'athula', 'athil', 'athoda', 'ithu', 'ithula', 'ithil', 'ithoda',
]);

function activePublishedCatalogRecordIds(artifacts, scope, usageDirection) {
  const activePublications = new Set((scope?.publications ?? []).map((publication) => (
    `${normalized(publication?.knowledgeBaseId)}:${Number(publication?.publicationRevision)}`
  )));
  return new Set((artifacts?.bundles ?? []).flatMap((bundle) => {
    const publicationKey = `${normalized(bundle?.knowledgeBaseId)}:${Number(bundle?.publicationRevision)}`;
    const assigned = Array.isArray(bundle?.assignedAgentIds) ? bundle.assignedAgentIds : [];
    if (!activePublications.has(publicationKey)
      || (scope?.agentId && assigned.length
        && !assigned.some((id) => normalized(id) === normalized(scope.agentId)))) return [];
    return (bundle.records ?? []).flatMap((record) => {
      const type = normalized(record.record_type ?? record.recordType);
      const usage = normalized(record.usage_direction ?? record.usageDirection ?? 'both');
      const id = cleanText(record.record_id ?? record.recordId ?? record.id, 160);
      return ['catalog_item', 'catalog_category'].includes(type)
        && ['both', normalized(usageDirection)].includes(usage) && id ? [normalized(id)] : [];
    });
  }));
}

/**
 * Bind an explicit conversational reference only to record IDs already
 * verified in call state and still present in the active publication. A new
 * published name must be resolved before this function is considered.
 */
export function deterministicContextualRequestDecision({
  artifacts, scope, usageDirection = 'both', latestUtterance, state = {},
} = {}) {
  const utterance = cleanText(latestUtterance, 2_000);
  const tokens = searchableTokens(utterance);
  if (tokens.length < 2 || !tokens.some((token) => contextualReferenceTokens.has(token))) return null;
  const rememberedComparison = textList(state.comparisonRecordIds, 20);
  const rememberedSingle = textList(state.lastReferencedRecordIds, 20);
  const remembered = rememberedComparison.length > 1
    ? rememberedComparison : (rememberedSingle.length === 1 ? rememberedSingle : []);
  if (!remembered.length) return null;
  const active = activePublishedCatalogRecordIds(artifacts, scope, usageDirection);
  if (!remembered.every((recordId) => active.has(normalized(recordId)))) return null;
  return Object.freeze({
    decision: 'SEARCH', response: '', clarification: null,
    search: Object.freeze({
      query: utterance,
      requestedFact: utterance,
      contextualReference: 'verified_previous_selection',
      preferredRecordIds: Object.freeze([...remembered]),
    }),
    tool: null, nextQuestion: null, stateUpdate: null,
  });
}

function addExactStructuredCandidates(result, exact, limit = 20) {
  const merged = [...exact, ...(result.channels?.structured ?? [])];
  // Preserve publication-derived identity and match metadata over provider duplicates.
  const unique = new Map();
  for (const candidate of merged) {
    const key = candidateIdentityKey(candidate, candidate.tenantId);
    if (key && !unique.has(key)) unique.set(key, candidate);
  }
  const structured = Object.freeze([...unique.values()].slice(0, limit).map((candidate, index) => Object.freeze({
    ...candidate, channel: 'structured', rank: index + 1,
  })));
  return Object.freeze({
    ...result,
    channels: Object.freeze({ ...(result.channels ?? {}), structured }),
  });
}

export const templateEngineSearchKinds = Object.freeze({
  OVERVIEW: 'overview',
  CATEGORY: 'category',
  NAMED_ENTITY: 'named_entity',
  CONTEXTUAL_FOLLOW_UP: 'contextual_follow_up',
  COMPARISON: 'comparison',
  GENERAL_KNOWLEDGE: 'general_knowledge',
});

function structuralTokens(value) {
  return new Set(cleanText(value, 1_000).toLocaleLowerCase()
    .replace(/[_:/.-]+/gu, ' ').split(/[^\p{L}\p{M}\p{N}]+/gu).filter(Boolean));
}

export function classifyTemplateEngineSearch({
  search = {}, state = {}, resolution = null, conversationGuidance = null,
} = {}) {
  const requested = structuralTokens(search.requestedFact);
  const guidance = structuralTokens([
    conversationGuidance?.intentClass, conversationGuidance?.nodeKey,
    conversationGuidance?.context,
  ].filter(Boolean).join(' '));
  const preferred = [...new Set([
    ...(search.preferredRecordIds ?? []),
  ].map((value) => cleanText(value, 160)).filter(Boolean))];
  let searchKind = templateEngineSearchKinds.GENERAL_KNOWLEDGE;
  if (preferred.length > 1 || requested.has('comparison') || requested.has('compare')
    || requested.has('difference') || requested.has('differences')) {
    searchKind = templateEngineSearchKinds.COMPARISON;
  } else if (preferred.length === 1 && cleanText(search.contextualReference, 500)) {
    searchKind = templateEngineSearchKinds.CONTEXTUAL_FOLLOW_UP;
  } else if (resolution?.candidate?.entityType === 'CATEGORY') {
    searchKind = templateEngineSearchKinds.CATEGORY;
  } else if (resolution?.candidate?.entityType === 'ITEM') {
    searchKind = templateEngineSearchKinds.NAMED_ENTITY;
  } else if (guidance.has('overview')) {
    searchKind = templateEngineSearchKinds.OVERVIEW;
  }
  return Object.freeze({
    searchKind,
    resolvedEntityType: resolution?.candidate?.entityType ?? null,
    resolvedNamespace: resolution?.candidateNamespace ?? null,
    hasResolvedEntity: Boolean(resolution?.candidate),
    comparisonRecordIds: Object.freeze(preferred.length > 1 ? preferred : []),
  });
}

function classification(input, search, state, resolution, conversationGuidance) {
  const searchClassification = classifyTemplateEngineSearch({
    search, state, resolution, conversationGuidance,
  });
  return Object.freeze({
    tenantId: input.tenantId,
    agentId: input.agentId,
    callId: input.callId,
    intentClass: `TEMPLATE_SEARCH_${searchClassification.searchKind.toUpperCase()}`,
    searchKind: searchClassification.searchKind,
    confidence: 1,
    relevantNamespaces: namespaces,
    primaryNamespaces: namespaces,
    requestedFacts: Object.freeze(search.requestedFact ? [search.requestedFact] : []),
    retrievalPlan: Object.freeze({ indexes, parallelChannels: Object.freeze([
      'structured', 'bm25', 'qdrant',
    ]) }),
  });
}

function candidateIdentityKey(candidate, tenantId) {
  return canonicalRecordIdentityKey(candidate, { tenantId });
}

function activePublicationKeys(publications = []) {
  return new Set((publications ?? []).map((publication) => (
    `${normalized(publication?.knowledgeBaseId)}:${Number(publication?.publicationRevision)}`
  )).filter((key) => !key.startsWith(':') && !key.endsWith(':0')));
}

function belongsToActivePublication(value, scope = {}) {
  if (normalized(value?.tenantId) !== normalized(scope.tenantId)) return false;
  if (scope.agentId && normalized(value?.agentId)
    && normalized(value.agentId) !== normalized(scope.agentId)) return false;
  const publications = activePublicationKeys(scope.publications);
  return publications.has(
    `${normalized(value?.knowledgeBaseId)}:${Number(value?.publicationRevision)}`,
  );
}

function resolutionReservations(resolution) {
  // Close alternatives are candidates for clarification, not a request to
  // hydrate every alternative as though the caller requested a comparison.
  const resolved = resolution?.ambiguity?.detected === true
    ? [] : resolution?.candidate ? [resolution.candidate] : [];
  return (resolved ?? []).filter((candidate) => {
    const recordType = cleanText(candidate?.recordType, 80).toUpperCase();
    return ['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(recordType)
      || (['FAQ', 'CONVERSATION_NODE'].includes(recordType)
        && candidate?.matchMethod === 'published_deterministic_id');
  }).flatMap((candidate) => {
    const evidenceRecordIds = candidate.recordType === 'CATALOG_CATEGORY'
      && Array.isArray(candidate.evidenceRecordIds) ? candidate.evidenceRecordIds : [];
    const identities = evidenceRecordIds.length
      ? evidenceRecordIds.map((recordId) => ({
        ...candidate, recordId, recordType: 'CATALOG_ITEM',
      })) : [candidate];
    return identities.map((identity) => Object.freeze({
      tenantId: identity.tenantId,
      agentId: identity.agentId,
      knowledgeBaseId: identity.knowledgeBaseId,
      publicationRevision: identity.publicationRevision,
      recordId: identity.recordId,
      recordType: identity.recordType,
      categoryKey: identity.categoryKey ?? null,
      reason: 'resolved_published_entity',
    }));
  });
}

export function constrainHybridToRequestedEntities(
  hybrid, tenantId, resolution = null, activeScope = null,
) {
  const scope = activeScope ?? { tenantId, publications: [] };
  const enforcePublicationScope = (scope.publications ?? []).length > 0;
  const isActive = (candidate) => normalized(candidate?.tenantId) === normalized(tenantId)
    && (!enforcePublicationScope || belongsToActivePublication(candidate, scope));
  const deduplicate = (values) => [...new Map((values ?? []).filter(isActive)
    .map((candidate) => [candidateIdentityKey(candidate, tenantId), candidate])
    .filter(([key]) => Boolean(key))).values()];
  const candidates = deduplicate(Array.isArray(hybrid?.candidates) ? hybrid.candidates : []);
  const activeChannels = Object.freeze(Object.fromEntries(
    Object.entries(hybrid.channels ?? {}).map(([channel, values]) => [
      channel, Object.freeze(deduplicate(values)),
    ]),
  ));
  const activeHybrid = Object.freeze({
    ...hybrid, channels: activeChannels, candidates: Object.freeze(candidates),
  });
  const existing = Array.isArray(hybrid?.queryContext?.reservedRecords)
    ? hybrid.queryContext.reservedRecords : [];
  const comparison = existing.filter((entry) => [
    'explicit_comparison', 'contextual_comparison',
  ].includes(String(entry?.reason ?? '').toLocaleLowerCase()));
  const explicitComparison = comparison.filter((entry) => (
    String(entry?.reason ?? '').toLocaleLowerCase() === 'explicit_comparison'
  ));
  const resolved = resolutionReservations(resolution);
  const explicitlyResolved = resolution?.candidate?.explicit === true ? resolved : [];
  const contextual = existing.filter((entry) => entry.reason === 'canonical_memory');
  // A newly and explicitly resolved published identity is the current subject.
  // It must replace stale contextual/comparison reservations rather than being
  // silently substituted by them. Non-explicit pronoun resolution still uses
  // the canonical memory path.
  let requested = (explicitComparison.length ? explicitComparison
    : explicitlyResolved.length ? explicitlyResolved
    : comparison.length ? comparison : contextual.length ? contextual : resolved).filter(isActive);
  if (!requested.length && resolution?.ambiguity?.detected !== true) {
    const exactCatalog = candidates.filter((candidate) => (
      ['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(String(candidate?.recordType ?? '').toUpperCase())
      && ['published_exact', 'published_category_exact'].includes(candidate?.matchMethod)
    ));
    const exactItems = exactCatalog.filter((candidate) => candidate.recordType === 'CATALOG_ITEM');
    const exact = exactItems.length ? exactItems : exactCatalog;
    requested = (exact.length === 1 ? exact : []).map((candidate) => Object.freeze({
      tenantId: candidate.tenantId,
      agentId: candidate.agentId,
      knowledgeBaseId: candidate.knowledgeBaseId,
      publicationRevision: candidate.publicationRevision,
      recordId: candidate.recordId,
      recordType: candidate.recordType,
      categoryKey: candidate.categoryKey ?? null,
      reason: 'explicit_entity',
    }));
  }
  const requestedByIdentity = new Map(requested.map((entry) => (
    [candidateIdentityKey(entry, tenantId), entry]
  )).filter(([key]) => Boolean(key)));
  if (!requestedByIdentity.size) return Object.freeze({
    hybrid: activeHybrid, constrained: false, comparison: false,
    requestedIdentities: Object.freeze([]),
    requestedRecordIds: Object.freeze([]),
  });
  const requestedIdentities = new Set(requestedByIdentity.keys());
  const constrainedCandidates = candidates.filter((candidate) => requestedIdentities.has(
    candidateIdentityKey(candidate, tenantId),
  ));
  const selectedIdentities = new Set(constrainedCandidates.map((candidate) => (
    candidateIdentityKey(candidate, tenantId)
  )).filter(Boolean));
  const missing = [...requestedIdentities].filter((key) => !selectedIdentities.has(key));
  if (missing.length) {
    throw new AppError(503, 'Requested published entities were not retained by retrieval',
      'TEMPLATE_ENGINE_REQUESTED_ENTITY_COVERAGE_INCOMPLETE', {
        requestedCount: requestedIdentities.size,
        retainedCount: selectedIdentities.size,
      });
  }
  const constrainedChannels = Object.freeze(Object.fromEntries(
    Object.entries(hybrid.channels ?? {}).map(([channel, values]) => [
      channel,
      Object.freeze(deduplicate(values).filter((candidate) => requestedIdentities.has(
        candidateIdentityKey(candidate, tenantId),
      ))),
    ]),
  ));
  const reservations = Object.freeze([...requestedByIdentity.values()].map((entry) => (
    Object.freeze({ ...entry })
  )));
  return Object.freeze({
    constrained: true,
    comparison: reservations.length > 1 && reservations.every((entry) => [
      'explicit_comparison', 'contextual_comparison',
    ].includes(String(entry.reason).toLocaleLowerCase())),
    requestedIdentities: Object.freeze([...requestedIdentities]),
    requestedRecordIds: Object.freeze([...new Set(
      reservations.map((entry) => cleanText(entry.recordId, 160)).filter(Boolean),
    )]),
    hybrid: Object.freeze({
      ...hybrid,
      channels: constrainedChannels,
      candidates: Object.freeze(constrainedCandidates),
      queryContext: Object.freeze({
        ...(hybrid.queryContext ?? {}), reservedRecords: reservations,
      }),
    }),
  });
}

function publishedAttributePaths(value, prefix = '', depth = 0, collected = []) {
  if (value === null || value === undefined || depth > 5 || collected.length >= 120) {
    return collected;
  }
  if (Array.isArray(value)) {
    for (const entry of value) publishedAttributePaths(entry, prefix, depth + 1, collected);
    return collected;
  }
  if (typeof value !== 'object') {
    if (prefix) collected.push(prefix);
    return collected;
  }
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    publishedAttributePaths(entry, path, depth + 1, collected);
    if (collected.length >= 120) break;
  }
  return collected;
}

function evidenceRecord(source, requestedFact = null) {
  const provenance = source.provenance ?? {};
  const authoritativeData = source.authoritativeData ?? source.facts ?? {};
  return Object.freeze({
    verified: source.hydrationValidated === true && source.publicationValidated === true,
    callerFacing: source.callerFacing === true,
    evidenceId: source.id,
    recordId: source.recordId,
    recordType: source.recordType,
    tenantId: source.tenantId,
    agentId: source.agentId,
    knowledgeBaseId: provenance.knowledgeBaseId ?? source.knowledgeBaseId,
    publicationRevision: Number(provenance.publicationRevision ?? source.publicationRevision),
    documentId: provenance.documentId ?? source.documentId,
    documentVersionId: provenance.documentVersionId ?? source.documentVersionId,
    documentName: provenance.uploadedFilename ?? provenance.documentName
      ?? source.uploadedFilename ?? source.documentName,
    documentDisplayName: provenance.documentDisplayName ?? source.documentDisplayName,
    documentType: provenance.documentType ?? source.documentType,
    pageNumber: provenance.pageNumber ?? source.pageNumber,
    pageEnd: provenance.pageEnd ?? source.pageEnd,
    sourceSection: provenance.sourceSection ?? source.sourceSection,
    sourceLineStart: provenance.sourceLineStart ?? source.sourceLineStart ?? source.sourceLine,
    sourceLineEnd: provenance.sourceLineEnd ?? source.sourceLineEnd,
    content: source.content ?? JSON.stringify(authoritativeData),
    canonicalName: source.canonicalName
      ?? source.authoritativeData?.name
      ?? source.authoritativeData?.category
      ?? null,
    aliases: Object.freeze(textList([
      ...textList(source.authoritativeData?.aliases),
      ...textList(source.authoritativeData?.categoryAliases),
      ...textList(source.searchForms),
    ])),
    relationships: source.authoritativeData?.relationships ?? [],
    authoritativeData,
    requestedFact: String(requestedFact ?? '').trim() || null,
    publishedAttributePaths: Object.freeze([...new Set(
      publishedAttributePaths(authoritativeData),
    )]),
  });
}

function normalized(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function verifyTemplateEngineEvidence(evidence, selectedCandidates, scope) {
  const publications = new Set(scope.publications.map((entry) => (
    `${normalized(entry.knowledgeBaseId)}:${Number(entry.publicationRevision)}`
  )));
  const selectedKeys = new Set(selectedCandidates.map((candidate) => (
    canonicalRecordIdentityKey(candidate, { tenantId: scope.tenantId })
  )).filter(Boolean));
  for (const source of evidence) {
    const publicationKey = `${normalized(source.knowledgeBaseId)}:${source.publicationRevision}`;
    const identityKey = canonicalRecordIdentityKey(source);
    const crossScope = normalized(source.tenantId) !== normalized(scope.tenantId)
      || (source.agentId && normalized(source.agentId) !== normalized(scope.agentId))
      || !publications.has(publicationKey);
    if (crossScope) {
      throw new AppError(500, 'PostgreSQL evidence is outside the template-engine scope',
        'TEMPLATE_ENGINE_HYDRATION_SCOPE_VIOLATION', {
          recordType: source.recordType || null,
        });
    }
    if (source.verified !== true || source.callerFacing !== true
      || !identityKey || !selectedKeys.has(identityKey) || !source.content) {
      throw new AppError(503, 'PostgreSQL evidence failed template-engine verification',
        'TEMPLATE_ENGINE_HYDRATED_EVIDENCE_INVALID', {
          recordType: source.recordType || null,
        });
    }
  }
  return Object.freeze(evidence);
}

function verifyHydratedScopeOnly(evidence, scope) {
  const publications = activePublicationKeys(scope.publications);
  for (const source of evidence) {
    const coordinates = source?.provenance ?? source ?? {};
    const knowledgeBaseId = coordinates.knowledgeBaseId ?? source?.knowledgeBaseId;
    const publicationRevision = Number(
      coordinates.publicationRevision ?? source?.publicationRevision,
    );
    const crossScope = normalized(source?.tenantId) !== normalized(scope.tenantId)
      || (source?.agentId && normalized(source.agentId) !== normalized(scope.agentId))
      || !publications.has(`${normalized(knowledgeBaseId)}:${publicationRevision}`);
    if (crossScope) {
      throw new AppError(500, 'PostgreSQL evidence is outside the template-engine scope',
        'TEMPLATE_ENGINE_HYDRATION_SCOPE_VIOLATION', {
          recordType: source?.recordType || null,
        });
    }
  }
}

function recoverableHydrationMiss(error) {
  return error?.code === 'KNOWLEDGE_AUTHORITATIVE_HYDRATION_EMPTY';
}

function publishedWorkflowRecord(record, publication, agentId) {
  const recordType = String(record?.record_type ?? record?.recordType ?? '').toLocaleUpperCase();
  if (recordType !== 'WORKFLOW_RULE') return null;
  const metadata = record.entity_metadata && typeof record.entity_metadata === 'object'
    ? record.entity_metadata : {};
  const recordId = String(record.record_id ?? record.recordId ?? '').trim();
  if (!recordId) return null;
  const authoritativeData = metadata.authoritativeData
    && typeof metadata.authoritativeData === 'object'
    && !Array.isArray(metadata.authoritativeData)
    ? metadata.authoritativeData : metadata;
  const actionConfig = metadata.actionConfig ?? metadata.action_config
    ?? authoritativeData.actionConfig ?? authoritativeData.action_config ?? null;
  const actionType = metadata.actionType ?? metadata.action_type
    ?? authoritativeData.actionType ?? authoritativeData.action_type ?? null;
  return Object.freeze({
    ...metadata,
    id: recordId,
    recordId,
    recordType,
    tenantId: publication.tenantId,
    agentId,
    knowledgeBaseId: publication.knowledgeBaseId,
    publicationRevision: publication.publicationRevision,
    published: true,
    status: 'published',
    actionType,
    actionConfig,
    authoritativeData,
  });
}

function publicationIndexKey(artifacts, scope, usageDirection) {
  const revisions = (artifacts.publications ?? []).map((publication) => [
    normalized(publication.knowledgeBaseId),
    Number(publication.publicationRevision),
  ].join('@')).sort();
  return [
    normalized(scope.tenantId), normalized(scope.agentId), normalized(usageDirection),
    ...revisions,
  ].join('|');
}

// This immutable index belongs to one production turn. It is revision-bound,
// but never stored globally, so no caller, turn, or tenant can reuse it.
export function createTemplateEnginePublicationIndex({
  artifacts, scope, usageDirection,
} = {}) {
  const publicationKeys = activePublicationKeys(artifacts?.publications);
  const bundles = (artifacts?.bundles ?? []).map((bundle, index) => {
    const publication = artifacts.publications?.[index] ?? {};
    return Object.freeze({
      ...bundle,
      tenantId: bundle?.tenantId ?? publication.tenantId ?? scope?.tenantId,
      knowledgeBaseId: bundle?.knowledgeBaseId ?? publication.knowledgeBaseId,
      publicationRevision: Number(
        bundle?.publicationRevision ?? publication.publicationRevision,
      ),
    });
  }).filter((bundle) => (
    normalized(bundle.tenantId) === normalized(scope?.tenantId)
    && publicationKeys.has(
      `${normalized(bundle.knowledgeBaseId)}:${Number(bundle.publicationRevision)}`,
    )
    && (!(bundle.assignedAgentIds ?? []).length
      || bundle.assignedAgentIds.some((id) => normalized(id) === normalized(scope?.agentId)))
  ));
  const publishedWorkflows = [];
  const publishedConversationGuidance = [];
  const categoryVocabularyByPublication = {};
  for (const bundle of bundles) {
    categoryVocabularyByPublication[
      `${normalized(bundle.knowledgeBaseId)}:${Number(bundle.publicationRevision)}`
    ] = publicationCategoryVocabulary(bundle, usageDirection);
    const publication = (artifacts.publications ?? []).find((entry) => (
      normalized(entry.knowledgeBaseId) === normalized(bundle.knowledgeBaseId)
      && Number(entry.publicationRevision) === Number(bundle.publicationRevision)
    ));
    if (!publication) continue;
    for (const record of bundle.records ?? []) {
      const workflow = publishedWorkflowRecord(record, publication, scope.agentId);
      if (workflow) publishedWorkflows.push(workflow);
      const guidance = normalizePublishedConversationGuidance(
        record, { ...publication, tenantId: scope.tenantId }, scope.agentId,
      );
      if (guidance) publishedConversationGuidance.push(guidance);
    }
  }
  return Object.freeze({
    key: publicationIndexKey(artifacts, scope, usageDirection),
    tenantId: scope.tenantId,
    agentId: scope.agentId,
    usageDirection,
    publications: artifacts.publications,
    bundles: Object.freeze(bundles),
    categoryVocabularyByPublication: Object.freeze(categoryVocabularyByPublication),
    publishedWorkflows: Object.freeze(publishedWorkflows),
    publishedConversationGuidance: Object.freeze(publishedConversationGuidance),
  });
}

function verifiedPreloadedPublicationIndex(index, artifacts, scope, usageDirection) {
  return index?.key === publicationIndexKey(artifacts, scope, usageDirection)
    && normalized(index.tenantId) === normalized(scope.tenantId)
    && normalized(index.agentId) === normalized(scope.agentId)
    && normalized(index.usageDirection) === normalized(usageDirection)
    ? index : null;
}

export async function loadTemplateEnginePublishedContext({
  auth, scope, callId, usageDirection, language,
} = {}, dependencies = {}) {
  const input = createKnowledgeEngineInput({
    tenantId: scope.tenantId,
    agentId: scope.agentId,
    callId,
    utterance: 'template engine published runtime context',
    usageDirection,
    language,
  });
  const artifacts = await (dependencies.loadArtifacts ?? loadPublishedEngineArtifacts)(
    auth, input, dependencies.artifacts,
  );
  const publicationIndex = createTemplateEnginePublicationIndex({
    artifacts, scope, usageDirection,
  });
  return Object.freeze({
    artifacts,
    scope: Object.freeze({ ...scope, publications: artifacts.publications }),
    publicationIndex,
    publishedWorkflows: publicationIndex.publishedWorkflows,
    publishedConversationGuidance: publicationIndex.publishedConversationGuidance,
  });
}

export async function retrieveTemplateEngineEvidence({
  auth, scope, callId, usageDirection, language, searchDecision, state = {}, runtimeProfile,
  preloadedArtifacts = null, conversationGuidance = null,
  preloadedPublicationIndex = null,
  latestUtterance = null,
  contextualMemoryVerified = false,
  contextualMemoryCandidate = false,
  deterministicRequestVerified = false,
  requestMeaning = null,
  reviewEntityCandidates = null,
  reviewContextualCandidates = null,
  isTurnCurrent = null,
} = {}, dependencies = {}) {
  const startedAt = performance.now();
  const assertCurrentTurn = () => {
    if (typeof isTurnCurrent === 'function' && !isTurnCurrent()) {
      const error = new Error('Template-engine retrieval was cancelled');
      error.name = 'AbortError';
      throw error;
    }
  };
  assertCurrentTurn();
  const resolutionUtterance = requestMeaning?.kind === 'published_welcome_continuation'
    ? requestMeaning.query : latestUtterance;
  if (!deterministicRequestVerified && !contextualMemoryVerified && !contextualMemoryCandidate) {
    state = { ...state, lastReferencedRecordIds: [], comparisonRecordIds: [] };
    if (searchDecision?.search) searchDecision = { ...searchDecision, search: {
      ...searchDecision.search, preferredRecordIds: [], contextualReference: null,
      query: requestMeaning?.kind === 'published_welcome_continuation'
        ? requestMeaning.query : latestUtterance || searchDecision.search.query,
    } };
  }
  // Deterministic IDs came from this turn's assigned publication snapshot,
  // not from model output. Keep them through generic search normalization;
  // the focused-record check below still rejects any ID outside that exact
  // tenant/agent/revision scope before provider or hydration work starts.
  const normalizationState = deterministicRequestVerified ? {
    ...state,
    lastReferencedRecordIds: [
      ...(state.lastReferencedRecordIds ?? []),
      ...(searchDecision?.search?.preferredRecordIds ?? []),
    ],
    comparisonRecordIds: (searchDecision?.search?.preferredRecordIds ?? []).length > 1
      ? searchDecision.search.preferredRecordIds : state.comparisonRecordIds,
  } : state;
  const normalizedSearch = normalizeTemplateEngineSearchDecision(
    searchDecision, normalizationState,
  );
  if (!normalizedSearch.valid) throw new TypeError('Template-engine retrieval requires valid SEARCH output');
  searchDecision = normalizedSearch.value;
  let search = searchDecision?.search;
  if (!search?.query) throw new TypeError('Template-engine retrieval requires SEARCH output');
  let input = createKnowledgeEngineInput({
    tenantId: scope.tenantId,
    agentId: scope.agentId,
    callId,
    utterance: search.query,
    usageDirection,
    language,
    requestedFacts: search.requestedFact ? [search.requestedFact] : [],
    contextualReferences: search.contextualReference ? [search.contextualReference] : [],
    recentRelevantTurns: state.recentCompleteTurns ?? [],
    memory: {
      recentConversation: state.recentCompleteTurns ?? [],
      citedEvidence: (state.lastReferencedRecordIds ?? []).map((recordId) => ({ id: recordId })),
      pendingClarification: state.pendingClarification,
      collectedToolFields: state.collectedToolFields,
    },
  });
  const artifacts = preloadedArtifacts ?? dependencies.preloadedArtifacts ?? await (
    dependencies.loadArtifacts ?? loadPublishedEngineArtifacts
  )(auth, input, dependencies.artifacts);
  assertCurrentTurn();
  const publicationIndex = verifiedPreloadedPublicationIndex(
    preloadedPublicationIndex, artifacts, scope, usageDirection,
  ) ?? createTemplateEnginePublicationIndex({ artifacts, scope, usageDirection });
  const scopedBundles = publicationIndex.bundles;
  const exactCandidates = exactPublishedCandidates(
    { ...artifacts, bundles: scopedBundles }, input,
    { ...search, query: resolutionUtterance || search.query }, 20, conversationGuidance,
    publicationIndex,
  );
  let entityResolution = scopedBundles.length
    ? (dependencies.resolveEntityRoute ?? resolvePublishedEntityRoute)(
      resolutionUtterance ? { ...input, utterance: resolutionUtterance } : input, scopedBundles, {
        confidenceConfiguration: dependencies.confidenceConfiguration,
      },
    ) : null;
  const exactItems = exactCandidates.filter((candidate) => (
    candidate.recordType === 'CATALOG_ITEM' && candidate.matchMethod === 'published_exact'
  ));
  let exactCatalog = exactItems.length ? exactItems : exactCandidates.filter((candidate) => (
    candidate.recordType === 'CATALOG_CATEGORY'
    && ['published_exact', 'published_category_exact'].includes(candidate.matchMethod)
    && candidate.score >= 0.98
  ));
  exactCatalog = [...new Map([...exactCatalog].sort((a, b) =>
    (a.evidenceRecordIds?.length ?? 0) - (b.evidenceRecordIds?.length ?? 0))
    .map((candidate) => [candidate.recordType === 'CATALOG_CATEGORY'
      ? `${candidate.knowledgeBaseId}:${candidate.publicationRevision}:${candidate.categoryKey}`
    : candidateIdentityKey(candidate, input.tenantId), candidate])).values()];
  const deterministicPreferredIds = new Set((deterministicRequestVerified
    ? search.preferredRecordIds ?? [] : []).map(normalized));
  const exactPublishedRoute = exactCandidates.filter((candidate) => (
    ['FAQ', 'CONVERSATION_NODE'].includes(candidate.recordType)
    && deterministicPreferredIds.has(normalized(candidate.recordId))
    && candidate.score >= 0.98
  ));
  let categoryConfirmation = false;
  let exactPublishedSelection = null;
  if (!exactCatalog.length) {
    const vocabulary = new Map();
    for (const bundle of scopedBundles) for (const [key, forms] of (
      publicationIndex.categoryVocabularyByPublication[
        `${normalized(bundle.knowledgeBaseId)}:${Number(bundle.publicationRevision)}`
      ] ?? publicationCategoryVocabulary(bundle, input.usageDirection)
    )) {
      const identity = `${normalized(bundle.knowledgeBaseId)}:${bundle.publicationRevision}:${key}`;
      vocabulary.set(identity, new Set(searchableTokens(publishedNameText(forms.join(' ')))));
    }
    const queryTokens = new Set(searchableTokens(publishedNameText(resolutionUtterance || search.query)));
    const distinctive = exactCandidates.filter((candidate) => {
      if (candidate.recordType !== 'CATALOG_CATEGORY' || !candidate.evidenceRecordIds?.length
        || candidate.score >= 0.98) return false;
      const identity = `${normalized(candidate.knowledgeBaseId)}:${candidate.publicationRevision}:${normalized(candidate.categoryKey)}`;
      const own = vocabulary.get(identity) ?? new Set();
      return [...own].some((token) => queryTokens.has(token)
        && [...vocabulary].every(([other, tokens]) => other === identity || !tokens.has(token)));
    });
    if (distinctive.length === 1) {
      exactCatalog = distinctive;
      categoryConfirmation = true;
    }
  }
  // Current named operands must reach fusion too: correcting only the exact
  // lookup still lets a rewritten single-subject query discard other operands.
  if (resolutionUtterance && exactCatalog.length) {
    search = Object.freeze({ ...search, query: resolutionUtterance,
      contextualReference: deterministicRequestVerified ? search.contextualReference : null,
      preferredRecordIds: Object.freeze(deterministicRequestVerified
        ? search.preferredRecordIds : []) });
    searchDecision = Object.freeze({ ...searchDecision, search });
  }
  // A unique explicit published name outranks contextual overview/FAQ matches.
  // Multiple names remain with the resolver and comparison-selection contract.
  if (exactCatalog.length === 1) {
    const candidate = exactCatalog[0];
    if (!categoryConfirmation) exactPublishedSelection = candidate;
    entityResolution = Object.freeze({
      ...entityResolution,
      candidate: Object.freeze({ ...candidate, explicit: !categoryConfirmation,
        entityType: candidate.recordType === 'CATALOG_ITEM' ? 'ITEM' : 'CATEGORY',
      }),
      candidateNamespace: 'CATALOG',
      action: categoryConfirmation ? 'CONFIRM' : 'CONTINUE', requiresCandidateConfirmation: categoryConfirmation,
      reason: categoryConfirmation ? 'published_category_distinctive_partial' : 'published_exact_selection',
      routingCandidates: [],
      ambiguity: Object.freeze({ detected: false, candidates: Object.freeze([]) }),
    });
  } else if (!exactCatalog.length && exactPublishedRoute.length === 1) {
    entityResolution = Object.freeze({
      ...entityResolution,
      candidate: Object.freeze({ ...exactPublishedRoute[0], explicit: true,
        matchMethod: 'published_deterministic_id', entityType: 'ROUTE' }),
      candidateNamespace: 'ROUTE', action: 'CONTINUE',
      requiresCandidateConfirmation: false, routingCandidates: Object.freeze([]),
      ambiguity: Object.freeze({ detected: false, candidates: Object.freeze([]) }),
      reason: 'published_deterministic_route',
    });
  }
  // Resolve remembered IDs from the current assigned publication, even when
  // lexical/semantic channels cannot match a pronoun-only follow-up.
  // Explicit published names always take precedence over stale memory hints.
  if (!exactCatalog.length && !contextualMemoryVerified
    && contextualMemoryCandidate && reviewContextualCandidates) {
    const candidates = scopedBundles.flatMap((bundle) => (bundle.records ?? [])
      .filter((record) => ['both', input.usageDirection].includes(normalized(record.usage_direction ?? record.usageDirection ?? 'both')))
      .map((record) => publishedRecordCandidate(record, bundle, input))
      .filter((candidate) => candidate && ['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(candidate.recordType))).slice(0, 80);
    const selected = await reviewContextualCandidates({ utterance: latestUtterance || search.query,
      recentTurns: state.recentCompleteTurns ?? [], candidates });
    if (selected?.length && selected.every((candidate) => candidates.includes(candidate))) {
      const names = selected.map((candidate) => candidate.canonicalName).filter(Boolean).join(' ');
      const expanded = exactPublishedCandidates({ ...artifacts, bundles: scopedBundles }, input,
        { ...search, query: names }, 80, null, publicationIndex)
        .filter((candidate) => candidate.score >= 0.98);
      const ids = [...new Set(selected.flatMap((candidate) => {
        const category = expanded.find((entry) => entry.recordType === 'CATALOG_CATEGORY'
          && entry.categoryKey === candidate.categoryKey && entry.knowledgeBaseId === candidate.knowledgeBaseId
          && entry.publicationRevision === candidate.publicationRevision);
        return category?.evidenceRecordIds?.length ? category.evidenceRecordIds : [candidate.recordId];
      }))];
      search = Object.freeze({ ...search, query: `${names} ${search.requestedFact ?? ''}`.trim(),
        preferredRecordIds: ids, contextualReference: names });
      searchDecision = Object.freeze({ ...searchDecision, search });
      input = { ...input, utterance: search.query, contextualReferences: [names] };
      state = { ...state, lastReferencedRecordIds: ids, comparisonRecordIds: [] };
    } else {
      contextualMemoryVerified = false;
      search = Object.freeze({ ...search, query: latestUtterance || search.query, preferredRecordIds: [], contextualReference: null });
      searchDecision = Object.freeze({ ...searchDecision, search });
      input = { ...input, utterance: search.query, contextualReferences: [] };
      state = { ...state, lastReferencedRecordIds: [], comparisonRecordIds: [] };
    }
  }
  const preferred = new Set((exactCatalog.length ? [] : search.preferredRecordIds ?? []).map(normalized));
  let contextualRecords = scopedBundles.flatMap((bundle) => (bundle.records ?? [])
    .filter((record) => preferred.has(normalized(record.record_id ?? record.recordId ?? record.id))
      && ['both', input.usageDirection].includes(normalized(record.usage_direction ?? record.usageDirection ?? 'both')))
    .map((record) => publishedRecordCandidate(record, bundle, input, { matchMethod: 'published_contextual' }))
    .filter((candidate) => candidate && ['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(candidate.recordType)));
  let contextualCategory = null;
  if (!exactCatalog.length && preferred.size === 1 && search.contextualReference) {
    // The LLM resolves the conversational reference to a published category
    // name/key. Require both an exact published form and the remembered anchor;
    // never expand an arbitrary item into all its siblings.
    const categories = exactPublishedCandidates({ ...artifacts, bundles: scopedBundles }, input,
      { ...search, query: search.contextualReference }, 20, null, publicationIndex)
      .filter((candidate) => candidate.recordType === 'CATALOG_CATEGORY' && candidate.score >= 0.98
        && candidate.evidenceRecordIds?.some((id) => preferred.has(normalized(id))));
    if (categories.length === 1) contextualCategory = categories[0];
  }
  if (preferred.size > 1 && [...preferred].some((id) => !contextualRecords.some(
    (candidate) => normalized(candidate.recordId) === id,
  ))) {
    throw new AppError(503, 'A remembered comparison operand is not in the active publication',
      'TEMPLATE_ENGINE_REQUESTED_ENTITY_COVERAGE_INCOMPLETE');
  }
  let retrievalState = state;
  if (contextualCategory) {
    const children = contextualCategory.evidenceRecordIds;
    search = Object.freeze({ ...search, preferredRecordIds: Object.freeze([...children]) });
    searchDecision = Object.freeze({ ...searchDecision, search });
    // This is a turn-local allowlist from the active publication, not model-
    // invented IDs and not a change to persistent conversation memory.
    retrievalState = { ...state, lastReferencedRecordIds: children, comparisonRecordIds: [] };
    contextualRecords = [];
    entityResolution = Object.freeze({ ...entityResolution,
      candidate: Object.freeze({ ...contextualCategory, entityType: 'CATEGORY', explicit: true }),
      candidateNamespace: 'CATALOG', action: 'CONTINUE', requiresCandidateConfirmation: false,
      ambiguity: Object.freeze({ detected: false, candidates: Object.freeze([]) }),
    });
  } else if (exactCatalog.length && !deterministicRequestVerified) {
    search = Object.freeze({ ...search, preferredRecordIds: Object.freeze([]) });
    searchDecision = Object.freeze({ ...searchDecision, search });
  } else if (contextualMemoryVerified && preferred.size === 1 && contextualRecords.length === 1
    && classifyTemplateEngineSearch({ search }).searchKind !== templateEngineSearchKinds.COMPARISON) {
    const candidate = contextualRecords[0];
    entityResolution = Object.freeze({ ...entityResolution,
      candidate: Object.freeze({ ...candidate, explicit: false,
        entityType: candidate.recordType === 'CATALOG_ITEM' ? 'ITEM' : 'CATEGORY' }),
      action: 'CONTINUE', reason: 'verified_contextual_memory',
      requiresCandidateConfirmation: false, candidateNamespace: 'CATALOG',
      ambiguity: Object.freeze({ detected: false, candidates: Object.freeze([]) }),
    });
  }
  const resolvedIdentities = new Set(resolutionReservations(entityResolution)
    .map((candidate) => candidateIdentityKey(candidate, input.tenantId)));
  if (resolvedIdentities.size > 20 || search.preferredRecordIds.length > 20) {
    throw new AppError(503, 'The requested set exceeds the bounded evidence capacity',
      'TEMPLATE_ENGINE_REQUESTED_ENTITY_COVERAGE_INCOMPLETE');
  }
  const resolvedRecords = scopedBundles.flatMap((bundle) => (bundle.records ?? [])
    .map((record) => publishedRecordCandidate(record, bundle, input))
    .filter((candidate) => candidate && resolvedIdentities.has(
      candidateIdentityKey(candidate, input.tenantId),
    )));
  const deterministicRecordIds = new Set(deterministicRequestVerified ? [
    ...(search.preferredRecordIds ?? []),
    ...exactCatalog.flatMap((candidate) => (
      candidate.recordType === 'CATALOG_CATEGORY' && candidate.evidenceRecordIds?.length
        ? candidate.evidenceRecordIds : [candidate.recordId]
    )),
  ].map(normalized).filter(Boolean) : []);
  const deterministicExactByRecordId = new Map(exactCandidates.map((candidate) => (
    [normalized(candidate.recordId), candidate]
  )));
  const focusedDeterministicCandidates = deterministicRecordIds.size
    ? scopedBundles.flatMap((bundle) => (bundle.records ?? [])
      .filter((record) => deterministicRecordIds.has(normalized(
        record.record_id ?? record.recordId ?? record.id,
      )) && ['both', input.usageDirection].includes(normalized(
        record.usage_direction ?? record.usageDirection ?? 'both',
      )))
      .map((record) => {
        const recordId = normalized(record.record_id ?? record.recordId ?? record.id);
        const exactCandidate = deterministicExactByRecordId.get(recordId);
        return publishedRecordCandidate(record, bundle, input, {
          score: exactCandidate?.score ?? 1,
          searchForms: exactCandidate?.searchForms,
          matchMethod: 'published_deterministic_id',
        });
      })
      .filter(Boolean)) : [];
  const focusedIds = new Set(focusedDeterministicCandidates.map((candidate) => (
    normalized(candidate.recordId)
  )));
  const focusedCoordinatesById = new Map();
  for (const candidate of focusedDeterministicCandidates) {
    const id = normalized(candidate.recordId);
    const coordinates = focusedCoordinatesById.get(id) ?? new Set();
    coordinates.add(`${normalized(candidate.knowledgeBaseId)}:${candidate.publicationRevision}`);
    focusedCoordinatesById.set(id, coordinates);
  }
  if (deterministicRecordIds.size
    && [...deterministicRecordIds].some((recordId) => !focusedIds.has(recordId)
      || focusedCoordinatesById.get(recordId)?.size !== 1)) {
    throw new AppError(503, 'A deterministically resolved record is outside the active publication',
      'TEMPLATE_ENGINE_REQUESTED_ENTITY_COVERAGE_INCOMPLETE', {
        requestedCount: deterministicRecordIds.size,
        retainedCount: focusedIds.size,
      });
  }
  const route = classification(
    input, search, state, entityResolution, conversationGuidance,
  );
  let channelPromise;
  const searchChannels = () => {
    channelPromise ??= (async () => {
      if (focusedDeterministicCandidates.length) {
        return Object.freeze({
          channels: Object.freeze({
            structured: Object.freeze(focusedDeterministicCandidates),
            bm25: Object.freeze([]),
            qdrant: Object.freeze([]),
          }),
        });
      }
      const result = await (dependencies.searchCandidates ?? searchParallelHybridCandidates)({
        input,
        classification: route,
        resolution: entityResolution,
        publicationBundles: scopedBundles,
        sparseIndexes: artifacts.sparseIndexes,
        limitPerChannel: 20,
      }, dependencies.retrieval);
      return addExactStructuredCandidates(
        result, [...contextualRecords, ...resolvedRecords, ...exactCandidates], 20,
      );
    })();
    return channelPromise;
  };
  let rawHybrid = await runTemplateEngineHybridRetrieval({
    decision: searchDecision,
    state: exactCatalog.length ? { ...state, lastReferencedRecordIds: [], comparisonRecordIds: [] } : retrievalState,
    scope: { ...scope, publications: artifacts.publications },
    limitPerChannel: 20,
    candidateLimit: 20,
  }, {
    searchStructuredPostgres: async () => (await searchChannels()).channels.structured,
    searchBm25: async () => (await searchChannels()).channels.bm25,
    searchQdrantE5: async () => (await searchChannels()).channels.qdrant,
  });
  const uncertainExactIdentity = exactCatalog.length > 1
    && entityResolution?.ambiguity?.detected === true;
  const identityReviewApplicable = uncertainExactIdentity || ![
    templateEngineSearchKinds.OVERVIEW,
  ].includes(route.searchKind);
  if ((!exactCatalog.length || uncertainExactIdentity) && !deterministicRequestVerified
    && !contextualMemoryVerified
    && requestMeaning?.kind !== 'published_welcome_continuation'
    && identityReviewApplicable && reviewEntityCandidates) {
    // Semantic hits are hints only. Rebind their identities to active published
    // records before exposing any candidate name to the language reviewer.
    const published = scopedBundles.flatMap((bundle) => (bundle.records ?? [])
      .filter((record) => ['both', input.usageDirection].includes(normalized(record.usage_direction ?? record.usageDirection ?? 'both')))
      .map((record) => publishedRecordCandidate(record, bundle, input))
      .filter((candidate) => candidate && ['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(candidate.recordType)));
    const byIdentity = new Map(published.map((candidate) => [candidateIdentityKey(candidate, input.tenantId), candidate]));
    const candidates = [...new Map([
      ...rawHybrid.candidates.map((candidate) => byIdentity.get(candidateIdentityKey(candidate, input.tenantId))).filter(Boolean),
      ...published,
    ].map((candidate) => [candidateIdentityKey(candidate, input.tenantId), candidate])).values()].slice(0, 80);
    const reviewed = await reviewEntityCandidates({ utterance: latestUtterance || search.query,
      candidates, recentTurns: state.recentCompleteTurns ?? [] });
    if (reviewed && candidates.includes(reviewed)) {
      const candidate = Object.freeze({ ...reviewed, matchMethod: 'published_multilingual_review', explicit: true,
        entityType: reviewed.recordType === 'CATALOG_ITEM' ? 'ITEM' : 'CATEGORY' });
      entityResolution = Object.freeze({ ...entityResolution, candidate, candidateNamespace: 'CATALOG',
        action: 'CONTINUE', reason: 'verified_multilingual_identity', requiresCandidateConfirmation: false,
        routingCandidates: [], ambiguity: { detected: false, candidates: [] } });
      rawHybrid = { ...rawHybrid, candidates: [...rawHybrid.candidates.filter((entry) =>
        candidateIdentityKey(entry, input.tenantId) !== candidateIdentityKey(candidate, input.tenantId)), candidate] };
    }
  }
  const entityConstraint = constrainHybridToRequestedEntities(
    rawHybrid, input.tenantId, entityResolution, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      publications: artifacts.publications,
    },
  );
  if (!categoryConfirmation && (entityConstraint.comparison || (entityResolution?.candidate?.entityType === 'CATEGORY'
    && entityResolution.candidate.evidenceRecordIds?.length))) {
    // Multiple deliberately selected operands are not alternative identities.
    entityResolution = Object.freeze({ ...entityResolution, candidate: null,
      action: 'CONTINUE', requiresCandidateConfirmation: false,
      ambiguity: Object.freeze({ detected: false, candidates: Object.freeze([]) }),
    });
  }
  const hybrid = entityConstraint.hybrid;
  const retrieval = Object.freeze({
    ...hybrid,
    tenantId: input.tenantId,
    agentId: input.agentId,
    callId: input.callId,
    recordTypes: Object.freeze([
      'CATALOG_ITEM', 'CATALOG_CATEGORY', 'FAQ', 'CONVERSATION_NODE',
      'WORKFLOW_RULE', 'KNOWLEDGE_CHUNK',
    ]),
  });
  const requestedIdentities = new Set(entityConstraint.requestedIdentities);
  const hydrate = dependencies.hydrateEvidence ?? rankAndHydrateAuthoritativeEvidence;
  // Cache only identical hydration work inside this retrieval turn. The key is
  // tenant/agent/revision scoped, and the Map is discarded on return.
  const hydrationCache = new Map();
  let hydrationCacheHits = 0;
  let hydrationCalls = 0;
  const rrfLimit = (count) => Math.max(1, Math.min(5, Number(count) || 5));
  const selectionForIdentities = (selection, identities) => {
    const allowed = new Set(identities);
    const candidates = (selection.candidates ?? []).filter((candidate) => allowed.has(
      candidateIdentityKey(candidate, input.tenantId),
    ));
    return Object.freeze({
      ...selection,
      candidates: Object.freeze(candidates),
      channels: Object.freeze(Object.fromEntries(Object.entries(selection.channels ?? {})
        .map(([channel, values]) => [channel, Object.freeze((values ?? []).filter(
          (candidate) => allowed.has(candidateIdentityKey(candidate, input.tenantId)),
        ))]))),
      queryContext: Object.freeze({
        ...(selection.queryContext ?? {}),
        reservedRecords: Object.freeze((selection.queryContext?.reservedRecords ?? []).filter(
          (candidate) => allowed.has(candidateIdentityKey(candidate, input.tenantId)),
        )),
      }),
    });
  };
  const hydrateOne = async (selection, selectionRetry = false) => {
    assertCurrentTurn();
    const identities = (selection.candidates ?? []).map((candidate) => (
      candidateIdentityKey(candidate, input.tenantId)
    )).filter(Boolean).sort();
    const cacheKey = [publicationIndex.key, selectionRetry ? 'retry' : 'initial', ...identities]
      .join('|');
    let pending = hydrationCache.get(cacheKey);
    if (pending) hydrationCacheHits += 1;
    else {
      hydrationCalls += 1;
      pending = Promise.resolve(hydrate({
        auth,
        input,
        classification: route,
        resolution: entityResolution,
        retrieval: selection,
        limit: rrfLimit(selection.candidates?.length),
        minProviderScore: 0,
        requireAtLeastOneHydratedEvidence: true,
        selectionRetry,
      }, dependencies.hydration));
      hydrationCache.set(cacheKey, pending);
    }
    try {
      const result = await pending;
      assertCurrentTurn();
      return result;
    } catch (error) {
      if (hydrationCache.get(cacheKey) === pending) hydrationCache.delete(cacheKey);
      throw error;
    }
  };
  const hydrateSelection = async (selection, selectionRetry = false) => {
    if (requestedIdentities.size <= 5) return hydrateOne(selection, selectionRetry);
    const identities = [...requestedIdentities];
    const batches = Array.from({ length: Math.ceil(identities.length / 5) }, (_, index) => (
      identities.slice(index * 5, (index + 1) * 5)
    ));
    const hydratedBatches = await Promise.all(batches.map((batch) => hydrateOne(
      selectionForIdentities(selection, batch), selectionRetry,
    )));
    const uniqueEvidence = new Map();
    const uniqueCandidates = new Map();
    const rejectedRecordIds = new Set();
    // Some hydrators return only evidence and omit their fusion candidates.
    // Retain the already-verified selection so the merged result still proves
    // coverage for every requested identity.
    for (const candidate of selection.candidates ?? []) {
      const key = candidateIdentityKey(candidate, input.tenantId);
      if (key && requestedIdentities.has(key) && !uniqueCandidates.has(key)) {
        uniqueCandidates.set(key, candidate);
      }
    }
    for (const result of hydratedBatches) {
      for (const source of result?.evidence ?? []) {
        const key = candidateIdentityKey(source, input.tenantId);
        if (key && !uniqueEvidence.has(key)) uniqueEvidence.set(key, source);
      }
      for (const candidate of result?.fusion?.candidates ?? []) {
        const key = candidateIdentityKey(candidate, input.tenantId);
        if (key && !uniqueCandidates.has(key)) uniqueCandidates.set(key, candidate);
      }
      for (const recordId of result?.rejectedRecordIds ?? []) rejectedRecordIds.add(recordId);
    }
    return Object.freeze({
      evidence: Object.freeze([...uniqueEvidence.values()]),
      fusion: Object.freeze({
        ...(hydratedBatches[0]?.fusion ?? {}),
        candidates: Object.freeze([...uniqueCandidates.values()]),
      }),
      rejectedRecordIds: Object.freeze([...rejectedRecordIds]),
    });
  };
  const exactSelection = () => {
    const candidates = retrieval.candidates.filter((candidate) => requestedIdentities.has(
      candidateIdentityKey(candidate, input.tenantId),
    ));
    return Object.freeze({
      ...retrieval,
      candidates: Object.freeze(candidates),
      channels: Object.freeze(Object.fromEntries(Object.keys(retrieval.channels ?? {}).map(
        (channel) => [channel, Object.freeze([...candidates])],
      ))),
    });
  };
  let selectionRetryAttempted = false;
  let authoritative;
  try {
    authoritative = await hydrateSelection(retrieval);
  } catch (error) {
    // A deterministic allowlist is already the exact retry selection. Running
    // the same hydration again adds latency and cannot discover another valid
    // record, so fail distinctly and let the configured recovery path speak.
    if (focusedDeterministicCandidates.length || !entityConstraint.constrained
      || !recoverableHydrationMiss(error)) throw error;
    selectionRetryAttempted = true;
    const retrySelection = exactSelection();
    try {
      authoritative = await hydrateSelection(retrySelection, true);
    } catch (retryError) {
      if (!recoverableHydrationMiss(retryError)) throw retryError;
      authoritative = Object.freeze({
        evidence: Object.freeze([]),
        fusion: Object.freeze({ candidates: retrySelection.candidates }),
        rejectedRecordIds: Object.freeze(retrySelection.candidates.map(
          (candidate) => candidate.recordId,
        )),
      });
    }
  }
  const hydrationState = (result) => {
    const all = Array.isArray(result?.evidence) ? result.evidence : [];
    const matched = entityConstraint.constrained
      ? all.filter((source) => requestedIdentities.has(
        candidateIdentityKey(source, input.tenantId),
      )) : all;
    const counts = new Map();
    for (const source of matched) {
      const key = candidateIdentityKey(source, input.tenantId);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Object.freeze({
      all, matched,
      exact: [...requestedIdentities].every((key) => counts.get(key) === 1)
        && matched.length === requestedIdentities.size,
    });
  };
  let hydrated = hydrationState(authoritative);
  if (entityConstraint.constrained && !hydrated.exact && !selectionRetryAttempted) {
    if (focusedDeterministicCandidates.length) {
      throw new AppError(503, 'Focused published evidence hydration was incomplete',
        'TEMPLATE_ENGINE_REQUESTED_ENTITY_HYDRATION_INCOMPLETE', {
          requestedCount: requestedIdentities.size,
          hydratedCount: hydrated.matched.length,
          selectionRetryAttempted: false,
        });
    }
    selectionRetryAttempted = true;
    try {
      authoritative = await hydrateSelection(exactSelection(), true);
    } catch (error) {
      if (!recoverableHydrationMiss(error)) throw error;
      throw new AppError(503, 'Requested evidence hydration retry failed',
        'TEMPLATE_ENGINE_REQUESTED_ENTITY_HYDRATION_INCOMPLETE');
    }
    hydrated = hydrationState(authoritative);
  }
  const hydratedEvidence = hydrated.all;
  verifyHydratedScopeOnly(hydratedEvidence, { ...scope, publications: artifacts.publications });
  const entityMatchedEvidence = hydrated.matched;
  const selectedCandidates = Array.isArray(authoritative?.fusion?.candidates)
    ? authoritative.fusion.candidates : retrieval.candidates;
  const requestedEntityHydrationIncomplete = entityConstraint.constrained && !hydrated.exact;
  if (requestedEntityHydrationIncomplete) {
    throw new AppError(503, 'Requested published records could not all be hydrated after retry',
      'TEMPLATE_ENGINE_REQUESTED_ENTITY_HYDRATION_INCOMPLETE', {
        requestedCount: requestedIdentities.size, hydratedCount: entityMatchedEvidence.length,
        selectionRetryAttempted,
      });
  }
  const evidence = verifyTemplateEngineEvidence(
    entityMatchedEvidence.map((source) => evidenceRecord(source, search.requestedFact))
      .slice(0, Math.max(5, requestedIdentities.size)),
    selectedCandidates,
    { ...scope, publications: artifacts.publications },
  );
  if (selectedCandidates.length > 0 && evidence.length === 0
    && !requestedEntityHydrationIncomplete) {
    throw new AppError(503,
      'Selected published records produced no verified template-engine evidence',
      'TEMPLATE_ENGINE_AUTHORITATIVE_EVIDENCE_EMPTY', {
        selectedCount: selectedCandidates.length,
        rejectedCount: Number(authoritative?.rejectedRecordIds?.length ?? 0),
      });
  }
  const requestedEntityRecordIds = entityConstraint.requestedRecordIds;
  const exactSelectionRecordIds = exactPublishedSelection?.recordType === 'CATALOG_CATEGORY'
    ? exactPublishedSelection.evidenceRecordIds ?? []
    : exactPublishedSelection?.recordId ? [exactPublishedSelection.recordId] : [];
  const normalizedRequestedIds = new Set(requestedEntityRecordIds.map(normalized).filter(Boolean));
  const normalizedExactIds = new Set(exactSelectionRecordIds.map(normalized).filter(Boolean));
  const normalizedVerifiedIds = new Set(evidence.filter((source) => (
    source?.verified === true && source?.callerFacing !== false
  )).map((source) => normalized(source.recordId)).filter(Boolean));
  const verifiedPublishedEntitySelection = exactPublishedSelection
    && normalizedExactIds.size > 0
    && normalizedExactIds.size === normalizedRequestedIds.size
    && [...normalizedExactIds].every((id) => normalizedRequestedIds.has(id)
      && normalizedVerifiedIds.has(id))
    ? Object.freeze({
      verified: true,
      matchMethod: exactPublishedSelection.matchMethod,
      knowledgeBaseId: exactPublishedSelection.knowledgeBaseId,
      publicationRevision: exactPublishedSelection.publicationRevision,
      requestedRecordIds: Object.freeze([...requestedEntityRecordIds]),
    }) : null;
  return Object.freeze({
    version: TEMPLATE_ENGINE_PRODUCTION_RETRIEVAL_VERSION,
    search,
    scope: Object.freeze({ ...scope, publications: artifacts.publications }),
    retrieval,
    evidence,
    requestedEntityRecordIds,
    diagnostics: Object.freeze({
      channelCounts: Object.freeze(Object.fromEntries(
        Object.entries(hybrid.channels).map(([channel, candidates]) => [
          channel, Array.isArray(candidates) ? candidates.length : 0,
        ]),
      )),
      retrievalCount: hybrid.candidates.length,
      hydrationCount: hydratedEvidence.length,
      verifiedEvidenceCount: evidence.length,
      preferredRecordIds: Object.freeze([...(search.preferredRecordIds ?? [])]),
      contextualMemoryVerified,
      entityMatch: Object.freeze({
        action: entityResolution?.action ?? null,
        reason: entityResolution?.reason ?? null,
        matchMethod: entityResolution?.candidate?.matchMethod
          ?? verifiedPublishedEntitySelection?.matchMethod ?? null,
        recordId: entityResolution?.candidate?.recordId
          ?? exactPublishedSelection?.recordId ?? null,
        requiresCandidateConfirmation: entityResolution?.requiresCandidateConfirmation === true,
        ambiguityDetected: entityResolution?.ambiguity?.detected === true,
      }),
      verifiedPublishedEntityFastPath: verifiedPublishedEntitySelection !== null,
      focusedDeterministicRetrieval: focusedDeterministicCandidates.length > 0,
      providerSearchPerformed: focusedDeterministicCandidates.length === 0,
      identityReviewApplicable,
      selectionRetryAttempted,
      requestedEntityHydrationIncomplete,
      requestedEntityCount: requestedIdentities.size,
      hydratedRequestedEntityCount: entityMatchedEvidence.length,
      publicationIndexKey: publicationIndex.key,
      hydrationCacheHits,
      hydrationCalls,
      failedChannels: Object.freeze(hybrid.failures.map((failure) => failure.channel)),
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    }),
    authoritative,
    entityResolution,
    verifiedPublishedEntitySelection,
    resolvedSearch: search,
    contextualMemoryVerified,
    searchClassification: Object.freeze({
      searchKind: categoryConfirmation ? templateEngineSearchKinds.CATEGORY
        : entityConstraint.comparison ? templateEngineSearchKinds.COMPARISON : route.searchKind,
      resolvedEntityType: entityResolution?.candidate?.entityType ?? null,
      resolvedNamespace: entityResolution?.candidateNamespace ?? null,
      requestedFact: search.requestedFact,
      requestedEntityRecordIds,
    }),
    artifacts,
  });
}
