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
  const value = record?.entity_metadata ?? record?.metadata;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function searchableTokens(value) {
  return [...new Set(cleanText(value, 4_000).toLocaleLowerCase()
    .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])];
}

function publishedFormScore(query, forms) {
  const queryText = cleanText(query, 4_000).toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  const queryTokens = new Set(searchableTokens(queryText));
  let best = 0;
  for (const form of forms) {
    const formText = cleanText(form, 500).toLocaleLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
    const formTokens = searchableTokens(formText);
    if (!formText || !formTokens.length) continue;
    if (queryText === formText) best = Math.max(best, 1);
    else if (queryText.includes(formText)) best = Math.max(best, 0.98);
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

export function exactPublishedCandidates(artifacts, input, search, limit = 20, guidance = null) {
  const candidates = [];
  const categoryMatches = new Map();
  const guidanceRecordId = normalized(guidance?.recordId);
  const referenceSelectors = publishedReferenceSelectors(guidance?.catalogReferences);
  for (const bundle of artifacts.bundles ?? []) {
    if (normalized(bundle?.tenantId) !== normalized(input.tenantId)) continue;
    for (const record of bundle.records ?? []) {
      const metadata = recordMetadata(record);
      const recordType = cleanText(
        record.record_type ?? record.recordType ?? record.type, 80,
      ).toUpperCase();
      const usage = cleanText(record.usage_direction ?? record.usageDirection ?? 'both', 20)
        .toLocaleLowerCase();
      if (!['both', cleanText(input.usageDirection, 20).toLocaleLowerCase()].includes(usage)) continue;
      const itemForms = textList([
        record.entity_name, record.itemKey, record.item_key,
        metadata.itemKey, metadata.item_key,
        ...(record.entity_aliases ?? []),
        ...(metadata.crossDocumentAliases ?? []),
        ...(record.publicationAliases ?? []),
        ...(record.publicationSttForms ?? []),
        ...(record.publicationPhoneticForms ?? []),
      ]);
      const categoryForms = textList([
        record.entity_category, record.categoryKey, record.category_key,
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
      const directForms = recordType === 'CATALOG_ITEM' ? itemForms : routeForms;
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
            : itemReference ? 'published_reference_exact' : 'published_exact',
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

function addExactStructuredCandidates(result, exact, limit = 20) {
  const merged = [...exact, ...(result.channels?.structured ?? [])];
  const structured = Object.freeze([...new Map(merged.map((candidate) => [
    `${cleanText(candidate.recordType, 80).toUpperCase()}:${normalized(candidate.recordId)}`,
    candidate,
  ])).values()].slice(0, limit).map((candidate, index) => Object.freeze({
    ...candidate, channel: 'structured', rank: index + 1,
  })));
  return Object.freeze({
    ...result,
    channels: Object.freeze({ ...(result.channels ?? {}), structured }),
  });
}

function classification(input, search) {
  return Object.freeze({
    tenantId: input.tenantId,
    agentId: input.agentId,
    callId: input.callId,
    intentClass: 'TEMPLATE_SEARCH',
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

function resolutionReservations(resolution) {
  const resolved = resolution?.ambiguity?.detected === true
    ? resolution.ambiguity.candidates
    : resolution?.candidate ? [resolution.candidate] : [];
  return (resolved ?? []).filter((candidate) => (
    ['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(
      cleanText(candidate?.recordType, 80).toUpperCase(),
    )
  )).map((candidate) => Object.freeze({
    tenantId: candidate.tenantId,
    agentId: candidate.agentId,
    knowledgeBaseId: candidate.knowledgeBaseId,
    publicationRevision: candidate.publicationRevision,
    recordId: candidate.recordId,
    recordType: candidate.recordType,
    categoryKey: candidate.categoryKey ?? null,
    reason: resolution?.ambiguity?.detected === true
      ? 'published_entity_ambiguity' : 'resolved_published_entity',
  }));
}

export function constrainHybridToRequestedEntities(hybrid, tenantId, resolution = null) {
  const candidates = Array.isArray(hybrid?.candidates) ? hybrid.candidates : [];
  const existing = Array.isArray(hybrid?.queryContext?.reservedRecords)
    ? hybrid.queryContext.reservedRecords : [];
  const comparison = existing.filter((entry) => [
    'explicit_comparison', 'contextual_comparison',
  ].includes(String(entry?.reason ?? '').toLocaleLowerCase()));
  const resolved = resolutionReservations(resolution);
  let requested = comparison.length ? comparison : resolved;
  if (!requested.length) {
    const exactCatalog = candidates.filter((candidate) => (
      ['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(String(candidate?.recordType ?? '').toUpperCase())
      && ['published_exact', 'published_category_exact'].includes(candidate?.matchMethod)
    ));
    const exactItems = exactCatalog.filter((candidate) => candidate.recordType === 'CATALOG_ITEM');
    requested = (exactItems.length ? exactItems : exactCatalog).map((candidate) => Object.freeze({
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
    hybrid, constrained: false, comparison: false,
    requestedIdentities: Object.freeze([]),
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
      Object.freeze((values ?? []).filter((candidate) => requestedIdentities.has(
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
    aliases: source.authoritativeData?.aliases
      ?? source.authoritativeData?.categoryAliases
      ?? [],
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
  const publishedWorkflows = artifacts.bundles.flatMap((bundle, index) => (
    (bundle.records ?? []).map((record) => publishedWorkflowRecord(
      record, artifacts.publications[index], scope.agentId,
    )).filter(Boolean)
  ));
  const publishedConversationGuidance = artifacts.bundles.flatMap((bundle, index) => (
    (bundle.records ?? []).map((record) => normalizePublishedConversationGuidance(
      record,
      { ...artifacts.publications[index], tenantId: scope.tenantId },
      scope.agentId,
    )).filter(Boolean)
  ));
  return Object.freeze({
    artifacts,
    scope: Object.freeze({ ...scope, publications: artifacts.publications }),
    publishedWorkflows: Object.freeze(publishedWorkflows),
    publishedConversationGuidance: Object.freeze(publishedConversationGuidance),
  });
}

export async function retrieveTemplateEngineEvidence({
  auth, scope, callId, usageDirection, language, searchDecision, state = {}, runtimeProfile,
  preloadedArtifacts = null, conversationGuidance = null,
} = {}, dependencies = {}) {
  const startedAt = performance.now();
  const search = searchDecision?.search;
  if (!search?.query) throw new TypeError('Template-engine retrieval requires SEARCH output');
  const input = createKnowledgeEngineInput({
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
  const route = classification(input, search);
  const scopedBundles = (artifacts.bundles ?? []).filter((bundle) => (
    cleanText(bundle?.tenantId, 160).toLocaleLowerCase()
      === cleanText(input.tenantId, 160).toLocaleLowerCase()
    && (!(bundle?.assignedAgentIds ?? []).length
      || bundle.assignedAgentIds.some((id) => (
        cleanText(id, 160).toLocaleLowerCase()
          === cleanText(input.agentId, 160).toLocaleLowerCase()
      )))
  ));
  const entityResolution = scopedBundles.length
    ? (dependencies.resolveEntityRoute ?? resolvePublishedEntityRoute)(
      input, scopedBundles, {
        confidenceConfiguration: dependencies.confidenceConfiguration,
      },
    ) : null;
  let channelPromise;
  const searchChannels = () => {
    channelPromise ??= (async () => {
      const result = await (dependencies.searchCandidates ?? searchParallelHybridCandidates)({
        input,
        classification: route,
        resolution: entityResolution,
        publicationBundles: artifacts.bundles,
        sparseIndexes: artifacts.sparseIndexes,
        limitPerChannel: 20,
      }, dependencies.retrieval);
      return addExactStructuredCandidates(
        result, exactPublishedCandidates(
          artifacts, input, search, 20, conversationGuidance,
        ), 20,
      );
    })();
    return channelPromise;
  };
  const rawHybrid = await runTemplateEngineHybridRetrieval({
    decision: searchDecision,
    state,
    scope: { ...scope, publications: artifacts.publications },
    limitPerChannel: 20,
    candidateLimit: 20,
  }, {
    searchStructuredPostgres: async () => (await searchChannels()).channels.structured,
    searchBm25: async () => (await searchChannels()).channels.bm25,
    searchQdrantE5: async () => (await searchChannels()).channels.qdrant,
  });
  const entityConstraint = constrainHybridToRequestedEntities(
    rawHybrid, input.tenantId, entityResolution,
  );
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
  const authoritative = await (dependencies.hydrateEvidence
    ?? rankAndHydrateAuthoritativeEvidence)({
    auth,
    input,
    classification: route,
    resolution: entityResolution,
    retrieval,
    limit: 5,
    minProviderScore: 0,
    requireAtLeastOneHydratedEvidence: true,
  }, dependencies.hydration);
  const hydratedEvidence = Array.isArray(authoritative.evidence)
    ? authoritative.evidence : [];
  const selectedCandidates = Array.isArray(authoritative?.fusion?.candidates)
    ? authoritative.fusion.candidates : retrieval.candidates;
  const requestedIdentities = new Set(entityConstraint.requestedIdentities);
  const entityMatchedEvidence = entityConstraint.constrained
    ? hydratedEvidence.filter((source) => requestedIdentities.has(
      candidateIdentityKey(source, input.tenantId),
    )) : hydratedEvidence;
  const hydratedIdentityCounts = new Map();
  for (const source of entityMatchedEvidence) {
    const key = candidateIdentityKey(source, input.tenantId);
    if (key) hydratedIdentityCounts.set(key, (hydratedIdentityCounts.get(key) ?? 0) + 1);
  }
  const exactHydration = [...requestedIdentities].every((key) => (
    hydratedIdentityCounts.get(key) === 1
  ));
  if (entityConstraint.constrained
    && (entityMatchedEvidence.length !== requestedIdentities.size || !exactHydration)) {
    throw new AppError(503, 'Requested published entities were not completely hydrated',
      'TEMPLATE_ENGINE_REQUESTED_ENTITY_HYDRATION_INCOMPLETE', {
        requestedCount: requestedIdentities.size,
        hydratedCount: entityMatchedEvidence.length,
        comparison: entityConstraint.comparison,
      });
  }
  const evidence = verifyTemplateEngineEvidence(
    entityMatchedEvidence.map((source) => evidenceRecord(source, search.requestedFact)).slice(0, 5),
    selectedCandidates,
    { ...scope, publications: artifacts.publications },
  );
  if (selectedCandidates.length > 0 && evidence.length === 0) {
    throw new AppError(503,
      'Selected published records produced no verified template-engine evidence',
      'TEMPLATE_ENGINE_AUTHORITATIVE_EVIDENCE_EMPTY', {
        selectedCount: selectedCandidates.length,
        rejectedCount: Number(authoritative?.rejectedRecordIds?.length ?? 0),
      });
  }
  return Object.freeze({
    version: TEMPLATE_ENGINE_PRODUCTION_RETRIEVAL_VERSION,
    search,
    scope: Object.freeze({ ...scope, publications: artifacts.publications }),
    retrieval,
    evidence,
    diagnostics: Object.freeze({
      channelCounts: Object.freeze(Object.fromEntries(
        Object.entries(hybrid.channels).map(([channel, candidates]) => [
          channel, Array.isArray(candidates) ? candidates.length : 0,
        ]),
      )),
      retrievalCount: hybrid.candidates.length,
      hydrationCount: hydratedEvidence.length,
      verifiedEvidenceCount: evidence.length,
      failedChannels: Object.freeze(hybrid.failures.map((failure) => failure.channel)),
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    }),
    authoritative,
    entityResolution,
    artifacts,
  });
}
