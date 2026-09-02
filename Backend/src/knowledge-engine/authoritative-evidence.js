import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { requireEntityId, requireTenantId } from '../rag/tenant-isolation.js';
import { knowledgeQueryClasses } from './query-classifier.js';
import { canonicalRecordIdentityKey, typedRecordIdentityKey } from './canonical-record-identity.js';
import { resolveKnowledgeConfidenceConfiguration } from '../knowledge-bases/knowledge-confidence-config.js';
import {
  collectCanonicalRetrievalReservations,
  isMandatoryCanonicalReservation,
} from './canonical-retrieval-reservations.js';
import { publicationDuplicateKeys } from './publication-deduplication.js';

export const AUTHORITATIVE_EVIDENCE_VERSION = 10;

const supportedRecordTypes = new Set([
  'CATALOG_ITEM', 'CATALOG_CATEGORY', 'FAQ', 'CONVERSATION_NODE', 'WORKFLOW_RULE', 'KNOWLEDGE_CHUNK',
]);

const recordNamespaces = Object.freeze({
  CATALOG_ITEM: 'CATALOG',
  CATALOG_CATEGORY: 'CATALOG',
  FAQ: 'FAQ',
  CONVERSATION_NODE: 'CONVERSATION',
  WORKFLOW_RULE: 'WORKFLOW',
  KNOWLEDGE_CHUNK: 'GENERAL',
});

export const authoritativeHydrationSql = `
  WITH requested AS (
    SELECT upper(record_type) AS record_type, record_id::uuid,
      knowledge_base_id::uuid, publication_revision::int,
      rank::int, rrf_score::double precision, category_key::text
      FROM jsonb_to_recordset($4::jsonb) AS candidate(
        record_type text, record_id text, knowledge_base_id text,
        publication_revision int, rank int, rrf_score double precision, category_key text
      )
  ), runtime_agent AS (
    SELECT id, usage_direction FROM voice_agents
     WHERE tenant_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL
  ), assigned AS (
    SELECT kb.id, kb.publication_revision
      FROM runtime_agent agent
      JOIN agent_knowledge_bases assignment
        ON assignment.tenant_id=$1 AND assignment.agent_id=agent.id
      JOIN knowledge_bases kb
        ON kb.tenant_id=assignment.tenant_id AND kb.id=assignment.knowledge_base_id
     WHERE kb.status='published' AND kb.deleted_at IS NULL AND kb.publication_revision>0
       AND (agent.usage_direction='both' OR agent.usage_direction=$3::agent_usage_direction)
       AND (assignment.usage_direction='both' OR assignment.usage_direction=$3::agent_usage_direction)
       AND (kb.usage_direction='both' OR kb.usage_direction=$3::agent_usage_direction)
       AND EXISTS (
         SELECT 1 FROM knowledge_processing_jobs job
          WHERE job.tenant_id=kb.tenant_id AND job.knowledge_base_id=kb.id
            AND job.job_type='index' AND job.status='completed'
            AND job.metadata->>'publicationRevision'=kb.publication_revision::text
       )
  ), evidence AS (
    SELECT 'FAQ'::text AS record_type, faq.id AS record_id, faq.knowledge_base_id,
      faq.tenant_id, assigned.publication_revision, faq.document_id, faq.document_version_id,
      document.original_filename AS document_name, faq.source_page_start, faq.source_page_end,
      faq.source_section, faq.source_line_start, faq.source_line_end,
      COALESCE(NULLIF(faq.language,''),'und') AS language, faq.answer AS content,
      true AS caller_facing,
      jsonb_build_object(
        'question',faq.question,'answer',faq.answer,'language',faq.language,
        'usageDirection',faq.usage_direction,'metadata',faq.metadata
      ) AS authoritative_data, requested.rank, requested.rrf_score
      FROM requested JOIN faq_entries faq
        ON requested.record_type='FAQ' AND faq.id=requested.record_id
      JOIN assigned ON assigned.id=faq.knowledge_base_id
        AND assigned.id=requested.knowledge_base_id
        AND assigned.publication_revision=requested.publication_revision
      JOIN knowledge_document_versions version
        ON version.tenant_id=faq.tenant_id AND version.knowledge_base_id=faq.knowledge_base_id
       AND version.document_id=faq.document_id AND version.id=faq.document_version_id
      JOIN knowledge_documents document
        ON document.tenant_id=faq.tenant_id AND document.knowledge_base_id=faq.knowledge_base_id
       AND document.id=faq.document_id
     WHERE faq.tenant_id=$1 AND faq.status='approved'
       AND (faq.usage_direction='both' OR faq.usage_direction=$3::agent_usage_direction)
       AND version.is_current=true AND version.status='ready' AND version.deleted_at IS NULL
       AND document.status='ready' AND document.deleted_at IS NULL
    UNION ALL
    SELECT 'KNOWLEDGE_CHUNK', chunk.id, chunk.knowledge_base_id, chunk.tenant_id,
      assigned.publication_revision, chunk.document_id, chunk.document_version_id,
      document.original_filename, chunk.source_page_start, chunk.source_page_end,
      chunk.source_section, chunk.source_line_start, chunk.source_line_end,
      COALESCE(NULLIF(document.metadata->>'language',''),'und'), chunk.content, true,
      jsonb_build_object(
        'heading',chunk.source_heading,'content',chunk.content,'chunkIndex',chunk.chunk_index,
        'tokenCount',chunk.token_count,'usageDirection',chunk.usage_direction,'metadata',chunk.metadata
      ), requested.rank, requested.rrf_score
      FROM requested JOIN knowledge_chunks chunk
        ON requested.record_type='KNOWLEDGE_CHUNK' AND chunk.id=requested.record_id
      JOIN assigned ON assigned.id=chunk.knowledge_base_id
        AND assigned.id=requested.knowledge_base_id
        AND assigned.publication_revision=requested.publication_revision
      JOIN knowledge_document_versions version
        ON version.tenant_id=chunk.tenant_id AND version.knowledge_base_id=chunk.knowledge_base_id
       AND version.document_id=chunk.document_id AND version.id=chunk.document_version_id
      JOIN knowledge_documents document
        ON document.tenant_id=chunk.tenant_id AND document.knowledge_base_id=chunk.knowledge_base_id
       AND document.id=chunk.document_id
     WHERE chunk.tenant_id=$1 AND chunk.status='approved'
       AND (chunk.usage_direction='both' OR chunk.usage_direction=$3::agent_usage_direction)
       AND version.is_current=true AND version.status='ready' AND version.deleted_at IS NULL
       AND document.status='ready' AND document.deleted_at IS NULL
    UNION ALL
    SELECT 'CATALOG_CATEGORY', anchor.id, anchor.knowledge_base_id, anchor.tenant_id,
      assigned.publication_revision, anchor.document_id, anchor.document_version_id,
      document.original_filename, anchor.source_page_start, anchor.source_page_end,
      anchor.source_section, anchor.source_line_start, anchor.source_line_end,
      COALESCE(NULLIF(document.metadata->>'language',''),'und'),
      concat_ws(E'\n','Category: '||COALESCE(anchor.category,catalog.name),
        CASE WHEN anchor.category_description IS NOT NULL
          THEN 'Description: '||anchor.category_description END,
        CASE WHEN children.values_json <> '[]'::jsonb
          THEN 'Available items: '||children.values_json::text END),
      true,
      jsonb_build_object(
        'catalogId',catalog.id,'catalogType',catalog.catalog_type,'catalogName',catalog.name,
        'categoryKey',anchor.category_key,'category',COALESCE(anchor.category,catalog.name),
        'categoryAliases',anchor.category_aliases,
        'categoryDescription',anchor.category_description,'children',children.values_json
      ), requested.rank, requested.rrf_score
      FROM requested JOIN structured_items anchor
        ON requested.record_type='CATALOG_CATEGORY' AND anchor.id=requested.record_id
       AND anchor.category_key=requested.category_key
      JOIN assigned ON assigned.id=anchor.knowledge_base_id
        AND assigned.id=requested.knowledge_base_id
        AND assigned.publication_revision=requested.publication_revision
      JOIN structured_catalogs catalog
        ON catalog.tenant_id=anchor.tenant_id AND catalog.knowledge_base_id=anchor.knowledge_base_id
       AND catalog.document_id=anchor.document_id
       AND catalog.document_version_id=anchor.document_version_id
       AND catalog.id=anchor.catalog_id AND catalog.status='approved'
      JOIN knowledge_document_versions version
        ON version.tenant_id=anchor.tenant_id AND version.knowledge_base_id=anchor.knowledge_base_id
       AND version.document_id=anchor.document_id AND version.id=anchor.document_version_id
      JOIN knowledge_documents document
        ON document.tenant_id=anchor.tenant_id AND document.knowledge_base_id=anchor.knowledge_base_id
       AND document.id=anchor.document_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'recordId',child.id,'itemKey',child.item_key,'name',child.name,
          'description',child.description,'price',child.price,'currency',child.currency,
          'displayOrder',child.display_order,'selectionRules',child.selection_rules
        ) ORDER BY child.display_order,child.id),'[]'::jsonb) AS values_json
          FROM structured_items child
         WHERE child.tenant_id=anchor.tenant_id
           AND child.knowledge_base_id=anchor.knowledge_base_id
           AND child.document_id=anchor.document_id
           AND child.document_version_id=anchor.document_version_id
           AND child.catalog_id=anchor.catalog_id AND child.category_key=anchor.category_key
           AND child.status='approved'
      ) children ON true
     WHERE anchor.tenant_id=$1 AND anchor.status='approved'
       AND version.is_current=true AND version.status='ready' AND version.deleted_at IS NULL
       AND document.status='ready' AND document.deleted_at IS NULL
    UNION ALL
    SELECT 'CATALOG_ITEM', item.id, item.knowledge_base_id, item.tenant_id,
      assigned.publication_revision, item.document_id, item.document_version_id,
      document.original_filename, item.source_page_start, item.source_page_end,
      item.source_section, item.source_line_start, item.source_line_end,
      COALESCE(NULLIF(document.metadata->>'language',''),'und'),
      concat_ws(E'\n','Item: '||item.name,
        'Category: '||COALESCE(item.category,catalog.name),
        CASE WHEN item.description IS NOT NULL THEN 'Description: '||item.description END,
        CASE WHEN item.price IS NOT NULL
          THEN 'Price: '||item.price::text||' '||COALESCE(item.currency,'') END,
        CASE WHEN attributes.values_json <> '[]'::jsonb
          THEN 'Details: '||attributes.values_json::text END,
        CASE WHEN item.source_text IS NOT NULL THEN 'Approved Source: '||item.source_text END),
      true,
      jsonb_build_object(
        'catalogId',catalog.id,'catalogType',catalog.catalog_type,'catalogName',catalog.name,
        'itemKey',item.item_key,'name',item.name,'aliases',item.aliases,
        'category',COALESCE(item.category,catalog.name),'categoryAliases',item.category_aliases,
        'categoryKey',item.category_key,'parentCategoryKey',item.parent_category_key,
        'categoryDescription',item.category_description,
        'description',item.description,'price',item.price,'currency',item.currency,
        'attributes',attributes.values_json,'relationships',item.relationships,
        'selectionRules',item.selection_rules,'sourceText',item.source_text
      ), requested.rank, requested.rrf_score
      FROM requested JOIN structured_items item
        ON requested.record_type='CATALOG_ITEM' AND item.id=requested.record_id
      JOIN assigned ON assigned.id=item.knowledge_base_id
        AND assigned.id=requested.knowledge_base_id
        AND assigned.publication_revision=requested.publication_revision
      JOIN structured_catalogs catalog
        ON catalog.tenant_id=item.tenant_id AND catalog.knowledge_base_id=item.knowledge_base_id
       AND catalog.document_id=item.document_id AND catalog.document_version_id=item.document_version_id
       AND catalog.id=item.catalog_id AND catalog.status='approved'
      JOIN knowledge_document_versions version
        ON version.tenant_id=item.tenant_id AND version.knowledge_base_id=item.knowledge_base_id
       AND version.document_id=item.document_id AND version.id=item.document_version_id
      JOIN knowledge_documents document
        ON document.tenant_id=item.tenant_id AND document.knowledge_base_id=item.knowledge_base_id
       AND document.id=item.document_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'key',attribute.attribute_key,'name',attribute.display_name,
          'value',attribute.value,'displayOrder',attribute.display_order
        ) ORDER BY attribute.display_order,attribute.id),'[]'::jsonb) AS values_json
          FROM structured_item_attributes attribute
         WHERE attribute.tenant_id=item.tenant_id
           AND attribute.knowledge_base_id=item.knowledge_base_id
           AND attribute.document_id=item.document_id
           AND attribute.document_version_id=item.document_version_id
           AND attribute.item_id=item.id
      ) attributes ON true
     WHERE item.tenant_id=$1 AND item.status='approved'
       AND version.is_current=true AND version.status='ready' AND version.deleted_at IS NULL
       AND document.status='ready' AND document.deleted_at IS NULL
    UNION ALL
    SELECT 'WORKFLOW_RULE', workflow.id, workflow.knowledge_base_id, workflow.tenant_id,
      assigned.publication_revision, workflow.document_id, workflow.document_version_id,
      document.original_filename, workflow.source_page_start, workflow.source_page_end,
      workflow.source_section, workflow.source_line_start, workflow.source_line_end,
      COALESCE(NULLIF(document.metadata->>'language',''),'und'),
      COALESCE(workflow.response_template,''),
      lower(COALESCE(workflow.action_config->>'responseMode','instruction'))='exact',
      jsonb_build_object(
        'name',workflow.name,'intent',workflow.intent,'priority',workflow.priority,
        'conditions',workflow.conditions,'actionType',workflow.action_type,
        'actionConfig',workflow.action_config,
        'responseMode',COALESCE(workflow.action_config->>'responseMode','instruction'),
        'responseTemplate',workflow.response_template,'usageDirection',workflow.usage_direction
      ), requested.rank, requested.rrf_score
      FROM requested JOIN workflow_rules workflow
        ON requested.record_type='WORKFLOW_RULE' AND workflow.id=requested.record_id
      JOIN assigned ON assigned.id=workflow.knowledge_base_id
        AND assigned.id=requested.knowledge_base_id
        AND assigned.publication_revision=requested.publication_revision
      JOIN knowledge_document_versions version
        ON version.tenant_id=workflow.tenant_id AND version.knowledge_base_id=workflow.knowledge_base_id
       AND version.document_id=workflow.document_id AND version.id=workflow.document_version_id
      JOIN knowledge_documents document
        ON document.tenant_id=workflow.tenant_id AND document.knowledge_base_id=workflow.knowledge_base_id
       AND document.id=workflow.document_id
     WHERE workflow.tenant_id=$1 AND workflow.status='approved'
       AND (workflow.usage_direction='both' OR workflow.usage_direction=$3::agent_usage_direction)
       AND version.is_current=true AND version.status='ready' AND version.deleted_at IS NULL
       AND document.status='ready' AND document.deleted_at IS NULL
    UNION ALL
    SELECT 'CONVERSATION_NODE', conversation.id, conversation.knowledge_base_id,
      conversation.tenant_id, assigned.publication_revision,
      conversation.document_id, conversation.document_version_id,
      document.original_filename, conversation.source_page_start, conversation.source_page_end,
      conversation.source_section, conversation.source_line_start, conversation.source_line_end,
      COALESCE(NULLIF(conversation.language,''),NULLIF(document.metadata->>'language',''),'und'),
      conversation.content, lower(COALESCE(conversation.node_type,''))<>'guidance',
      jsonb_build_object(
        'flowKey',conversation.flow_key,'nodeKey',conversation.node_key,
        'nodeType',conversation.node_type,'language',conversation.language,
        'sequenceOrder',conversation.sequence_order,'isEntry',conversation.is_entry,
        'content',conversation.content,'variables',conversation.variables,
        'transitions',conversation.transitions,'usageDirection',conversation.usage_direction
      ), requested.rank, requested.rrf_score
      FROM requested JOIN conversation_flows conversation
        ON requested.record_type='CONVERSATION_NODE' AND conversation.id=requested.record_id
      JOIN assigned ON assigned.id=conversation.knowledge_base_id
        AND assigned.id=requested.knowledge_base_id
        AND assigned.publication_revision=requested.publication_revision
      JOIN knowledge_document_versions version
        ON version.tenant_id=conversation.tenant_id
       AND version.knowledge_base_id=conversation.knowledge_base_id
       AND version.document_id=conversation.document_id AND version.id=conversation.document_version_id
      JOIN knowledge_documents document
        ON document.tenant_id=conversation.tenant_id
       AND document.knowledge_base_id=conversation.knowledge_base_id
       AND document.id=conversation.document_id
     WHERE conversation.tenant_id=$1 AND conversation.status='approved'
       AND (conversation.usage_direction='both'
         OR conversation.usage_direction=$3::agent_usage_direction)
       AND version.is_current=true AND version.status='ready' AND version.deleted_at IS NULL
       AND document.status='ready' AND document.deleted_at IS NULL
  ) SELECT evidence.*,
      document.display_name AS document_display_name,
      document.document_type::text AS document_type,
      document.status::text AS document_status,
      version.status::text AS document_version_status,
      version.is_current AS document_version_is_current
    FROM evidence
    JOIN knowledge_documents document
      ON document.tenant_id=evidence.tenant_id
     AND document.knowledge_base_id=evidence.knowledge_base_id
     AND document.id=evidence.document_id
    JOIN knowledge_document_versions version
      ON version.tenant_id=evidence.tenant_id
     AND version.knowledge_base_id=evidence.knowledge_base_id
     AND version.document_id=evidence.document_id
     AND version.id=evidence.document_version_id
   ORDER BY rank,record_type,record_id`;

function normalizeId(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function sameScope(left, right) {
  return left.recordType === right.recordType
    && normalizeId(left.knowledgeBaseId) === normalizeId(right.knowledgeBaseId)
    && Number(left.publicationRevision) === Number(right.publicationRevision);
}

function recordKey(value = {}) {
  return typedRecordIdentityKey(value);
}

function unitScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

function latestRequestRelevance(candidate = {}) {
  const providerScores = candidate.providerScores ?? {};
  const tokenCoverages = candidate.tokenCoverages ?? {};
  const lexicalScore = tokenCoverages.bm25 === undefined
    ? unitScore(providerScores.bm25) : unitScore(tokenCoverages.bm25);
  return Math.max(
    unitScore(providerScores.qdrant),
    unitScore(providerScores.structured),
    lexicalScore,
  );
}

export function fuseCandidateRankings(retrieval, {
  rrfK = 60,
  limit = 5,
  minProviderScore = resolveKnowledgeConfidenceConfiguration().clarificationConfidence,
  highProviderScore = resolveKnowledgeConfidenceConfiguration().highConfidence,
  relevanceScoreMargin = resolveKnowledgeConfidenceConfiguration().ambiguityMargin,
  allowedRecordTypes = retrieval?.recordTypes ?? null,
  reservedRecordIds = [],
  reservedRecordKeys = [],
} = {}) {
  if (!Number.isFinite(rrfK) || rrfK <= 0) throw new TypeError('rrfK must be positive');
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new TypeError('RRF limit must be between 1 and 5');
  }
  if (!Number.isFinite(minProviderScore) || minProviderScore < 0) {
    throw new TypeError('RRF minimum provider score must be non-negative');
  }
  if (!Number.isFinite(highProviderScore) || highProviderScore < minProviderScore) {
    throw new TypeError('RRF high provider score must be at least the minimum provider score');
  }
  if (!Number.isFinite(relevanceScoreMargin)
    || relevanceScoreMargin < 0 || relevanceScoreMargin > 1) {
    throw new TypeError('RRF relevance score margin must be between zero and one');
  }
  const allowedTypes = Array.isArray(allowedRecordTypes) && allowedRecordTypes.length
    ? new Set(allowedRecordTypes.map((value) => String(value).toUpperCase())) : null;
  const retrievalReservations = retrieval?.queryContext?.reservedRecords ?? [];
  const reservedIds = [...new Set([
    ...reservedRecordIds,
    ...retrievalReservations.map((reservation) => reservation?.recordId),
  ].map(normalizeId).filter(Boolean))];
  const reservedSet = new Set(reservedIds);
  const reservedKeys = new Set([
    ...reservedRecordKeys,
    ...retrievalReservations.map(recordKey),
  ].map((value) => String(value ?? '').trim()).filter(Boolean));
  const reservedCandidate = (candidate) => reservedKeys.has(recordKey(candidate))
    || (!reservedKeys.size && reservedSet.has(normalizeId(candidate.recordId)));
  const fused = new Map();
  const conflictedKeys = new Set();
  const conflictedIds = new Set();
  const rejectedNamespaceIds = new Set();
  for (const [channel, candidates] of Object.entries(retrieval?.channels ?? {})) {
    for (const [position, candidate] of (candidates ?? []).entries()) {
      const recordId = normalizeId(candidate.recordId);
      const recordType = String(candidate.recordType ?? '').toUpperCase();
      if (!recordId || !supportedRecordTypes.has(recordType)) continue;
      if (allowedTypes && !allowedTypes.has(recordType)) {
        rejectedNamespaceIds.add(recordId);
        continue;
      }
      const identity = {
        recordId: candidate.recordId,
        recordType,
        knowledgeBaseId: candidate.knowledgeBaseId,
        publicationRevision: Number(candidate.publicationRevision),
        namespace: recordNamespaces[recordType],
        categoryKey: candidate.categoryKey ?? null,
        callerFacingHint: candidate.callerFacingHint === true,
        authorizationHint: candidate.authorizationHint === true,
        deduplicationIdentity: Object.freeze({ ...(candidate.deduplicationIdentity ?? {}) }),
      };
      const key = canonicalRecordIdentityKey(identity, { tenantId: retrieval?.tenantId });
      if (!key) continue;
      const current = fused.get(key);
      if (current && !sameScope(current, identity)) {
        conflictedKeys.add(key);
        conflictedIds.add(recordId);
        continue;
      }
      // A provider may accidentally return the same record more than once.
      // RRF grants at most one contribution per channel so duplicate rows cannot
      // inflate a record's fused rank.
      if (current?.channelRanks[channel]) continue;
      const rank = Number(candidate.namespaceRank ?? position + 1);
      const next = current ?? {
        ...identity, rrfScore: 0, channelRanks: {}, providerScores: {},
        tokenCoverages: {}, channels: [],
      };
      next.rrfScore += 1 / (rrfK + rank);
      next.channelRanks[channel] = rank;
      next.providerScores[channel] = Number(candidate.score ?? 0);
      if (candidate.tokenCoverage !== undefined) {
        next.tokenCoverages[channel] = unitScore(candidate.tokenCoverage);
      }
      next.channels.push(channel);
      fused.set(key, next);
    }
  }
  for (const key of conflictedKeys) fused.delete(key);
  const ranked = [...fused.values()].sort((left, right) => right.rrfScore - left.rrfScore
      || left.recordType.localeCompare(right.recordType)
      || normalizeId(left.recordId).localeCompare(normalizeId(right.recordId)));
  const rejectedWeakIds = [];
  const accepted = ranked.filter((candidate) => {
    const strongestProviderScore = Math.max(0, ...Object.values(candidate.providerScores));
    const strong = reservedCandidate(candidate)
      || candidate.channels.length > 1
      || strongestProviderScore >= minProviderScore;
    if (!strong) rejectedWeakIds.push(normalizeId(candidate.recordId));
    return strong;
  });
  const reservedOrder = new Map([...reservedKeys].map((key, index) => [key, index]));
  const reserved = accepted.filter(reservedCandidate).sort((left, right) => {
    const leftOrder = reservedOrder.get(recordKey(left)) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = reservedOrder.get(recordKey(right)) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || right.rrfScore - left.rrfScore;
  });
  const primaryNamespaceOrder = new Map((retrieval?.primaryNamespaces ?? [])
    .map((namespace, index) => [String(namespace).trim().toUpperCase(), index]));
  const namespaceOrder = (candidate) => primaryNamespaceOrder.get(candidate.namespace)
    ?? Number.MAX_SAFE_INTEGER;
  const rejectedUnrelatedWorkflowIds = [];
  const rejectedUnrelatedCatalogIds = [];
  const rejectedUnrelatedConversationIds = [];
  const rejectedUnrelatedNamespaceIds = [];
  const rejectedBelowRelevanceBandIds = [];
  const reservations = retrieval?.queryContext?.reservedRecords ?? [];
  const focusedCatalogReasons = new Set([
    'explicit_entity', 'explicit_current_entity', 'canonical_memory', 'latest_request_record',
  ]);
  const hasFocusedCatalogRecord = reservations.some((reservation) => (
    ['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(
      String(reservation?.recordType ?? '').toUpperCase(),
    ) && focusedCatalogReasons.has(String(reservation?.reason ?? '').toLowerCase())
  ));
  const broadCatalogRequest = ['CATEGORY_OVERVIEW', 'COMPARISON_COMPLEX'].includes(
    String(retrieval?.intentClass ?? '').toUpperCase(),
  ) || retrieval?.queryContext?.need?.requestedRecommendation === true;
  let bestLatestRequestScore = 0;
  for (const candidate of accepted) {
    if (reservedCandidate(candidate) || candidate.callerFacingHint !== true
      || ['WORKFLOW_RULE', 'CONVERSATION_NODE'].includes(candidate.recordType)) continue;
    if (['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(candidate.recordType)
      && hasFocusedCatalogRecord && !broadCatalogRequest) continue;
    const requestRelevance = latestRequestRelevance(candidate);
    const inPrimaryNamespace = primaryNamespaceOrder.size === 0
      || primaryNamespaceOrder.has(candidate.namespace);
    const stronglyCorroboratedFallback = candidate.channels.length > 1
      && requestRelevance >= highProviderScore;
    if (!inPrimaryNamespace && !stronglyCorroboratedFallback) continue;
    bestLatestRequestScore = Math.max(
      bestLatestRequestScore, requestRelevance,
    );
  }
  const ordinary = accepted.filter((candidate) => {
    if (reservedCandidate(candidate)) return false;
    if (['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(candidate.recordType)
      && hasFocusedCatalogRecord && !broadCatalogRequest) {
      rejectedUnrelatedCatalogIds.push(normalizeId(candidate.recordId));
      return false;
    }
    const requestRelevance = latestRequestRelevance(candidate);
    const inPrimaryNamespace = primaryNamespaceOrder.size === 0
      || primaryNamespaceOrder.has(candidate.namespace);
    const stronglyCorroboratedFallback = candidate.callerFacingHint === true
      && candidate.channels.length > 1
      && requestRelevance >= highProviderScore;
    // Internal guidance and Workflow instructions are authorization context,
    // not spare caller-facing evidence. They enter the five-record package
    // only through an explicit/latest action reservation or an active-tool
    // authorization hint. Similar wording alone must never activate a rule.
    if (candidate.recordType === 'WORKFLOW_RULE') {
      const relevantCallerWorkflow = candidate.authorizationHint === true;
      if (!relevantCallerWorkflow) {
        rejectedUnrelatedWorkflowIds.push(normalizeId(candidate.recordId));
      }
      return relevantCallerWorkflow;
    }
    // Conversation nodes control sequencing. Only an exact current-turn route
    // reserved above may enter the grounding package; semantic similarity must
    // never use unrelated guidance or another scripted response as padding.
    if (candidate.recordType === 'CONVERSATION_NODE') {
      rejectedUnrelatedConversationIds.push(normalizeId(candidate.recordId));
      return false;
    }
    if (candidate.callerFacingHint !== true) {
      rejectedUnrelatedNamespaceIds.push(normalizeId(candidate.recordId));
      return false;
    }
    const insideLatestRequestBand = requestRelevance
      >= Math.max(minProviderScore, bestLatestRequestScore - relevanceScoreMargin);
    const independentlyRelevant = requestRelevance >= highProviderScore
      || (candidate.channels.length > 1 && requestRelevance >= minProviderScore);
    if (!insideLatestRequestBand || !independentlyRelevant) {
      rejectedBelowRelevanceBandIds.push(normalizeId(candidate.recordId));
      return false;
    }
    // Namespaces not signalled by the latest interpreted request are recovery
    // channels. Admit them only when independent retrieval channels strongly
    // corroborate the same canonical record; a lone generic match cannot fill
    // a top-five slot ahead of relevant evidence.
    if (!inPrimaryNamespace && !stronglyCorroboratedFallback) {
      rejectedUnrelatedNamespaceIds.push(normalizeId(candidate.recordId));
      return false;
    }
    return true;
  }).sort((left, right) => Number(
      right.callerFacingHint === true || right.authorizationHint === true,
    ) - Number(left.callerFacingHint === true || left.authorizationHint === true)
      || namespaceOrder(left) - namespaceOrder(right)
      || right.rrfScore - left.rrfScore
      || latestRequestRelevance(right) - latestRequestRelevance(left)
      || left.recordType.localeCompare(right.recordType)
      || normalizeId(left.recordId).localeCompare(normalizeId(right.recordId)));
  // Explicit, contextual and comparison reservations are never collapsed.
  // Ordinary candidates are duplicates when either their exact publication
  // coordinates or their tenant-scoped semantic identity has already won.
  const claimedDuplicateKeys = new Set(reserved.flatMap(publicationDuplicateKeys));
  const rejectedDuplicateIds = [];
  const deduplicatedOrdinary = ordinary.filter((candidate) => {
    const keys = publicationDuplicateKeys(candidate);
    if (keys.some((key) => claimedDuplicateKeys.has(key))) {
      rejectedDuplicateIds.push(normalizeId(candidate.recordId));
      return false;
    }
    for (const key of keys) claimedDuplicateKeys.add(key);
    return true;
  });
  const selected = [...reserved, ...deduplicatedOrdinary].slice(0, limit);
  const selectedIds = new Set(selected.map((candidate) => normalizeId(candidate.recordId)));
  const selectedKeys = new Set(selected.map(recordKey));
  const candidates = selected
    .map((candidate, index) => Object.freeze({
      ...candidate,
      canonicalIdentityKey: canonicalRecordIdentityKey(candidate, {
        tenantId: retrieval?.tenantId,
      }),
      rank: index + 1,
      rrfScore: Math.round(candidate.rrfScore * 1e12) / 1e12,
      channels: Object.freeze([...new Set(candidate.channels)]),
      channelRanks: Object.freeze({ ...candidate.channelRanks }),
      providerScores: Object.freeze({ ...candidate.providerScores }),
      tokenCoverages: Object.freeze({ ...candidate.tokenCoverages }),
      latestRequestRelevance: Math.round(latestRequestRelevance(candidate) * 1e6) / 1e6,
      deduplicationIdentity: Object.freeze({ ...(candidate.deduplicationIdentity ?? {}) }),
    }));
  return Object.freeze({
    version: AUTHORITATIVE_EVIDENCE_VERSION,
    tenantId: retrieval?.tenantId,
    agentId: retrieval?.agentId,
    callId: retrieval?.callId,
    rrfK,
    candidates: Object.freeze(candidates),
    rejectedScopeConflictIds: Object.freeze([...conflictedIds]),
    rejectedNamespaceIds: Object.freeze([...rejectedNamespaceIds]),
    rejectedWeakIds: Object.freeze(rejectedWeakIds),
    rejectedDuplicateIds: Object.freeze(rejectedDuplicateIds),
    rejectedUnrelatedCatalogIds: Object.freeze(rejectedUnrelatedCatalogIds),
    rejectedUnrelatedWorkflowIds: Object.freeze(rejectedUnrelatedWorkflowIds),
    rejectedUnrelatedConversationIds: Object.freeze(rejectedUnrelatedConversationIds),
    rejectedUnrelatedNamespaceIds: Object.freeze(rejectedUnrelatedNamespaceIds),
    rejectedBelowRelevanceBandIds: Object.freeze(rejectedBelowRelevanceBandIds),
    reservedRecordIds: Object.freeze(reservedIds),
    missingReservedRecordIds: Object.freeze(reservedIds.filter((id) => !selectedIds.has(id))),
    reservedRecordKeys: Object.freeze([...reservedKeys]),
    missingReservedRecordKeys: Object.freeze([...reservedKeys].filter((key) => !selectedKeys.has(key))),
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stableValue(child)]));
}

function fingerprint(value) {
  return JSON.stringify(stableValue(value));
}

function normalizedText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function conflictProjection(evidence) {
  const data = evidence.authoritativeData ?? {};
  if (evidence.recordType === 'CATALOG_ITEM') return {
    identity: `catalog:${normalizedText(data.categoryKey ?? data.category)}:${normalizedText(data.itemKey ?? data.name)}`,
    facts: {
      name: data.name, description: data.description, price: data.price, currency: data.currency,
      attributes: data.attributes, relationships: data.relationships,
      selectionRules: data.selectionRules,
    },
  };
  if (evidence.recordType === 'FAQ') return {
    identity: `faq:${normalizedText(data.question)}`, facts: { answer: data.answer },
  };
  if (evidence.recordType === 'WORKFLOW_RULE') return {
    identity: `workflow:${normalizedText(data.intent)}`,
    facts: {
      actionType: data.actionType, actionConfig: data.actionConfig,
      responseTemplate: data.responseTemplate,
    },
  };
  if (evidence.recordType === 'CONVERSATION_NODE') return {
    identity: `conversation:${normalizedText(data.flowKey)}:${normalizedText(data.nodeKey)}:${normalizedText(data.language)}`,
    facts: { content: data.content, nodeType: data.nodeType },
  };
  return null;
}

export function detectAuthoritativeConflicts(evidence) {
  const groups = new Map();
  for (const item of evidence) {
    const projection = conflictProjection(item);
    if (!projection || projection.identity.endsWith(':')) continue;
    const group = groups.get(projection.identity) ?? [];
    group.push({ item, facts: projection.facts });
    groups.set(projection.identity, group);
  }
  const conflicts = [];
  for (const [identity, group] of groups) {
    const variants = new Set(group.map((entry) => fingerprint(entry.facts)));
    if (group.length > 1 && variants.size > 1) conflicts.push(Object.freeze({
      identity,
      recordIds: Object.freeze(group.map((entry) => entry.item.recordId)),
      variantCount: variants.size,
    }));
  }
  return Object.freeze({ detected: conflicts.length > 0, conflicts: Object.freeze(conflicts) });
}

export function detectEntityAmbiguity(evidence, classification, resolution) {
  const confidenceConfiguration = resolveKnowledgeConfidenceConfiguration(
    classification?.confidenceConfiguration ?? resolution?.confidenceConfiguration,
  );
  if (classification?.intentClass === knowledgeQueryClasses.COMPARISON_COMPLEX) {
    return Object.freeze({ detected: false, candidates: Object.freeze([]), reason: null });
  }
  // A resolved category and its hydrated children are one authoritative answer
  // set. Child items must never compete with their own parent category merely
  // because they share a generic category phrase.
  if (resolution?.candidate?.entityType === 'CATEGORY') {
    const categoryKey = normalizeId(resolution.candidate.categoryKey);
    const categoryHydrated = evidence.some((item) => (
      normalizeId(item.authoritativeData?.categoryKey) === categoryKey
    ));
    if (categoryKey && categoryHydrated) {
      return Object.freeze({ detected: false, candidates: Object.freeze([]), reason: null });
    }
  }
  const selectedNamespace = resolution?.candidateNamespace ?? null;
  const hydratedIds = new Set(evidence.map((item) => normalizeId(item.recordId)));
  const namespaceRecordTypes = Object.freeze({
    CATALOG: new Set(['CATALOG_ITEM', 'CATALOG_CATEGORY']),
    FAQ: new Set(['FAQ']),
    CONVERSATION: new Set(['CONVERSATION_NODE']),
    WORKFLOW: new Set(['WORKFLOW_RULE']),
    GENERAL: new Set(['KNOWLEDGE_CHUNK']),
  });
  const allowedTypes = namespaceRecordTypes[selectedNamespace] ?? new Set();
  const confirmationTieWindow = confidenceConfiguration.ambiguityMargin;
  const ranked = (resolution?.routingCandidates ?? []).filter((candidate) => (
    allowedTypes.has(String(candidate.recordType ?? '').toUpperCase())
    && hydratedIds.has(normalizeId(candidate.recordId))
  )).sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0));
  const topScore = Number(ranked[0]?.score ?? 0);
  const tied = ranked.filter((candidate) => (
    topScore - Number(candidate.score ?? 0) <= confirmationTieWindow
  ));
  const evidenceByRecordId = new Map(evidence.map((item) => [normalizeId(item.recordId), item]));
  const candidates = tied.map((candidate) => Object.freeze({
    recordId: candidate.recordId,
    recordType: candidate.recordType,
    itemKey: candidate.itemKey ?? null,
    name: candidate.recordType === 'FAQ'
      ? evidenceByRecordId.get(normalizeId(candidate.recordId))?.sourceSection ?? candidate.label ?? null
      : candidate.label ?? null,
    categoryKey: candidate.categoryKey ?? null,
    namespace: selectedNamespace,
    score: candidate.score,
    matchedPhrase: (candidate.signals ?? []).filter((signal) => signal.explicit === true)
      .sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0))[0]?.phrase ?? null,
  }));
  const distinct = new Set(candidates.map((candidate) => {
    const source = evidenceByRecordId.get(normalizeId(candidate.recordId));
    if (candidate.recordType === 'FAQ' && source) return [
      'faq', source.documentId, source.sourceSection,
      normalizedText(source.authoritativeData?.answer),
    ].join(':');
    return candidate.itemKey ?? candidate.categoryKey ?? candidate.recordId;
  }));
  const detected = (classification?.requiresConfirmation === true || resolution?.action === 'CONFIRM')
    && distinct.size > 1;
  return Object.freeze({
    detected,
    candidates: Object.freeze(detected ? candidates.slice(0, 5) : []),
    namespace: detected ? selectedNamespace : null,
    reason: detected ? 'near_tied_authoritative_candidates_in_selected_namespace' : null,
  });
}

function rememberedContextCandidate(input) {
  // Requested facts and contextual references are interpreted by the single
  // grounded LLM after retrieval. Therefore they cannot be prerequisites for
  // retaining the call's canonical topic in the evidence package. The
  // remembered record is only a reserved context candidate; an explicit
  // current-turn entity still takes priority in reservedResolutionCandidates.
  const memory = input?.canonicalCallMemory ?? input?.memory ?? {};
  const activeEntity = memory.activeEntity
    ?? ((memory.knownEntities ?? []).length === 1 ? memory.knownEntities[0] : null);
  const recordId = normalizeId(activeEntity?.recordId ?? activeEntity?.id);
  if (recordId) return { recordId, recordType: 'CATALOG_ITEM' };
  const activeCategory = memory.activeCategory;
  const categoryRecordId = normalizeId(activeCategory?.recordId ?? activeCategory?.id);
  return categoryRecordId
    ? { recordId: categoryRecordId, recordType: 'CATALOG_CATEGORY' } : null;
}

function reservedResolutionCandidates(input, classification, resolution, retrieval) {
  return collectCanonicalRetrievalReservations({
    input, classification, resolution,
  }, retrieval).map((candidate) => ({
    recordId: normalizeId(candidate.recordId),
    recordType: String(candidate.recordType ?? '').toUpperCase(),
    categoryKey: candidate.categoryKey ?? null,
    reason: candidate.reason,
  }));
}

function evidenceFromRow(row, input, fused, context = {}) {
  const key = recordKey({ recordId: row.record_id, recordType: row.record_type });
  const contextual = Boolean(context.rememberedRecordKey
    && key === context.rememberedRecordKey);
  const explicit = Boolean(context.explicitRecordKey && key === context.explicitRecordKey);
  const provenance = Object.freeze({
    tenantId: input.tenantId,
    agentId: input.agentId,
    knowledgeBaseId: String(row.knowledge_base_id),
    publicationRevision: Number(row.publication_revision),
    recordType: String(row.record_type).toUpperCase(),
    recordId: String(row.record_id),
    documentId: String(row.document_id),
    documentVersionId: String(row.document_version_id),
    uploadedFilename: row.document_name ?? null,
    documentDisplayName: row.document_display_name ?? null,
    documentType: row.document_type ?? null,
    pageNumber: row.source_page_start ?? null,
    pageEnd: row.source_page_end ?? null,
    sourceSection: row.source_section ?? null,
    sourceLineStart: row.source_line_start
      ?? row.authoritative_data?.metadata?.sourceLineStart ?? null,
    sourceLineEnd: row.source_line_end
      ?? row.authoritative_data?.metadata?.sourceLineEnd ?? null,
  });
  return Object.freeze({
    id: `published:${String(row.record_type).toLocaleLowerCase()}:${row.record_id}`,
    recordType: String(row.record_type).toUpperCase(),
    recordId: String(row.record_id),
    tenantId: input.tenantId,
    agentId: input.agentId,
    knowledgeBaseId: String(row.knowledge_base_id),
    publicationRevision: Number(row.publication_revision),
    documentId: String(row.document_id),
    documentVersionId: String(row.document_version_id),
    documentName: row.document_name ?? null,
    documentDisplayName: row.document_display_name ?? null,
    documentType: row.document_type ?? null,
    pageNumber: row.source_page_start ?? null,
    pageEnd: row.source_page_end ?? null,
    sourceSection: row.source_section ?? row.authoritative_data?.heading
      ?? row.authoritative_data?.nodeKey
      ?? row.authoritative_data?.itemKey
      ?? row.authoritative_data?.name
      ?? null,
    sourceLineStart: row.source_line_start
      ?? row.authoritative_data?.metadata?.sourceLineStart ?? null,
    sourceLineEnd: row.source_line_end
      ?? row.authoritative_data?.metadata?.sourceLineEnd ?? null,
    language: row.language ?? 'und',
    content: String(row.content ?? '').trim(),
    callerFacing: row.caller_facing === true,
    authoritativeData: Object.freeze(stableValue(row.authoritative_data ?? {})),
    rank: fused.rank,
    rrfScore: fused.rrfScore,
    channels: Object.freeze([...new Set([
      ...fused.channels,
      ...(contextual ? ['conversation_memory'] : []),
      ...(explicit ? ['catalog_identity'] : []),
    ])]),
    reservationReasons: Object.freeze([...new Set(
      (context.reservationReasons ?? []).map((reason) => String(reason ?? '').trim())
        .filter(Boolean),
    )]),
    retrievalContext: contextual ? 'contextual' : 'primary',
    channelRanks: fused.channelRanks,
    providerScores: fused.providerScores,
    hydrationValidated: true,
    publicationValidated: true,
    documentStatus: row.document_status ?? null,
    documentVersionStatus: row.document_version_status ?? null,
    documentVersionIsCurrent: row.document_version_is_current === true,
    provenance,
  });
}

function verifyHydratedEvidenceRecord(source, input) {
  const invalid = [];
  if (normalizeId(source?.tenantId) !== normalizeId(input?.tenantId)) invalid.push('tenantId');
  if (normalizeId(source?.agentId) !== normalizeId(input?.agentId)) invalid.push('agentId');
  if (!source?.knowledgeBaseId || !Number.isInteger(source?.publicationRevision)
    || source.publicationRevision < 1) invalid.push('publicationScope');
  if (!source?.recordId || !supportedRecordTypes.has(source?.recordType)) {
    invalid.push('recordIdentity');
  }
  if (!source?.documentId || !source?.documentVersionId) invalid.push('documentProvenance');
  if (String(source?.documentStatus ?? '').toLowerCase() !== 'ready') {
    invalid.push('documentStatus');
  }
  if (String(source?.documentVersionStatus ?? '').toLowerCase() !== 'ready'
    || source?.documentVersionIsCurrent !== true) invalid.push('documentVersionStatus');
  const provenance = source?.provenance ?? {};
  for (const field of [
    'tenantId', 'agentId', 'knowledgeBaseId', 'publicationRevision',
    'recordId', 'recordType', 'documentId', 'documentVersionId',
  ]) {
    if (normalizeId(provenance[field]) !== normalizeId(source?.[field])) {
      invalid.push(`provenance.${field}`);
    }
  }
  if (invalid.length) {
    throw new AppError(503,
      'PostgreSQL hydration returned evidence with invalid publication provenance',
      'KNOWLEDGE_AUTHORITATIVE_PROVENANCE_INCOMPLETE', {
        stage: 'authoritative_hydration',
        recordId: source?.recordId ?? null,
        recordType: source?.recordType ?? null,
        invalidFields: [...new Set(invalid)],
      });
  }
  return source;
}

export async function rankAndHydrateAuthoritativeEvidence({
  auth,
  input,
  classification,
  resolution,
  retrieval,
  rrfK = 60,
  limit = 5,
  minProviderScore,
  confidenceConfiguration: suppliedConfidenceConfiguration,
}, dependencies = {}) {
  const tenantId = requireTenantId(auth?.tenantId);
  const agentId = requireEntityId(input?.agentId, 'agentId');
  const confidenceConfiguration = resolveKnowledgeConfidenceConfiguration(
    suppliedConfidenceConfiguration
      ?? classification?.confidenceConfiguration
      ?? resolution?.confidenceConfiguration,
  );
  const effectiveMinProviderScore = Number.isFinite(minProviderScore)
    ? minProviderScore : confidenceConfiguration.clarificationConfidence;
  if (normalizeId(tenantId) !== normalizeId(requireTenantId(input?.tenantId))
    || normalizeId(retrieval?.tenantId) !== normalizeId(input.tenantId)
    || normalizeId(retrieval?.agentId) !== normalizeId(agentId)
    || String(retrieval?.callId ?? '') !== String(input.callId ?? '')) {
    throw new TypeError('Authoritative hydration requires same-tenant, same-call retrieval');
  }
  if (!['inbound', 'outbound'].includes(input.usageDirection)) {
    throw new TypeError('Authoritative hydration requires inbound or outbound usage direction');
  }
  const reservedCandidates = reservedResolutionCandidates(input, classification, resolution, retrieval);
  const mandatoryReservedCandidates = reservedCandidates.filter(
    isMandatoryCanonicalReservation,
  );
  const reservationReasonsByRecordKey = new Map();
  for (const candidate of reservedCandidates) {
    const key = recordKey(candidate);
    if (!key) continue;
    const reasons = reservationReasonsByRecordKey.get(key) ?? new Set();
    if (candidate.reason) reasons.add(String(candidate.reason));
    reservationReasonsByRecordKey.set(key, reasons);
  }
  const reservedRecordIds = reservedCandidates.map((candidate) => candidate.recordId);
  const reservedRecordKeys = reservedCandidates.map(recordKey);
  const resolvedCategoryKey = resolution?.candidate?.entityType === 'CATEGORY'
    ? normalizeId(resolution.candidate.categoryKey) : null;
  const resolvedCategoryAnchorId = resolvedCategoryKey
    ? normalizeId(resolution.candidate.recordId) : null;
  const fusionRetrieval = resolvedCategoryKey ? Object.freeze({
    ...retrieval,
    channels: Object.freeze(Object.fromEntries(Object.entries(retrieval?.channels ?? {})
      .map(([channel, candidates]) => [channel, Object.freeze((candidates ?? []).filter((candidate) => !(
        String(candidate.recordType ?? '').toUpperCase() === 'CATALOG_ITEM'
        && (normalizeId(candidate.recordId) === resolvedCategoryAnchorId
          || normalizeId(candidate.categoryKey) === resolvedCategoryKey)
      ))) ]))),
  }) : retrieval;
  const fusion = fuseCandidateRankings(fusionRetrieval, {
    rrfK,
    limit,
    minProviderScore: effectiveMinProviderScore,
    highProviderScore: confidenceConfiguration.highConfidence,
    relevanceScoreMargin: confidenceConfiguration.ambiguityMargin,
    allowedRecordTypes: retrieval?.recordTypes,
    reservedRecordIds,
    reservedRecordKeys,
  });
  const contextRunner = dependencies.contextRunner ?? withTenantContext;
  let rows = [];
  if (fusion.candidates.length) {
    const requested = fusion.candidates.map((candidate) => ({
      record_type: candidate.recordType,
      record_id: candidate.recordId,
      knowledge_base_id: candidate.knowledgeBaseId,
      publication_revision: candidate.publicationRevision,
      rank: candidate.rank,
      rrf_score: candidate.rrfScore,
      category_key: candidate.categoryKey ?? null,
    }));
    rows = await contextRunner(auth, async (client) => {
      const result = await client.query(authoritativeHydrationSql, [
        tenantId, agentId, input.usageDirection, JSON.stringify(requested),
      ]);
      return result.rows;
    });
  }
  const fusedById = new Map(fusion.candidates.map((candidate) => (
    [candidate.canonicalIdentityKey, candidate]
  )));
  const remembered = resolution?.candidate?.explicit === true
    ? null : rememberedContextCandidate(input);
  const rememberedRecordKey = recordKey(remembered);
  const explicitRecordKey = resolution?.candidate?.explicit === true
    ? recordKey(resolution.candidate) : null;
  const evidenceById = new Map();
  for (const row of rows) {
    const hydratedIdentityKey = canonicalRecordIdentityKey({
      tenantId: input.tenantId,
      knowledgeBaseId: row.knowledge_base_id,
      publicationRevision: Number(row.publication_revision),
      recordId: row.record_id,
      recordType: row.record_type,
    });
    const fused = fusedById.get(hydratedIdentityKey);
    if (!fused || !sameScope(fused, {
      recordType: String(row.record_type).toUpperCase(),
      knowledgeBaseId: row.knowledge_base_id,
      publicationRevision: Number(row.publication_revision),
    })) continue;
    const key = hydratedIdentityKey;
    if (!evidenceById.has(key)) evidenceById.set(key, evidenceFromRow(row, input, fused, {
      rememberedRecordKey, explicitRecordKey,
      reservationReasons: [...(reservationReasonsByRecordKey.get(recordKey({
        recordId: row.record_id, recordType: row.record_type,
      })) ?? [])],
    }));
  }
  const evidence = [...evidenceById.values()].sort((left, right) => left.rank - right.rank);
  const hydratedIdentityKeys = new Set(evidence.map((source) => canonicalRecordIdentityKey(source)));
  const hydratedTypedKeys = new Set(evidence.map(recordKey));
  const rejectedRecordIds = fusion.candidates
    .filter((candidate) => !hydratedIdentityKeys.has(candidate.canonicalIdentityKey))
    .map((candidate) => candidate.recordId);
  const verifiedRecords = Object.freeze(evidence.map((source) => (
    verifyHydratedEvidenceRecord(source, input)
  )));
  const comparisonReservedCandidates = mandatoryReservedCandidates.filter((candidate) => (
    candidate.reason === 'explicit_comparison'
  ));
  const missingComparisonRecordKeys = comparisonReservedCandidates.map(recordKey)
    .filter((key) => !hydratedTypedKeys.has(key));
  const missingComparisonRecordIds = comparisonReservedCandidates.filter((candidate) => (
    missingComparisonRecordKeys.includes(recordKey(candidate))
  )).map((candidate) => candidate.recordId);
  const detectedAmbiguity = detectEntityAmbiguity(evidence, classification, resolution);
  const ambiguity = missingComparisonRecordIds.length
    ? Object.freeze({
      detected: true,
      candidates: Object.freeze([]),
      namespace: 'CATALOG',
      reason: 'comparison_entities_not_authoritatively_hydrated',
    })
    : detectedAmbiguity;
  const conflict = detectAuthoritativeConflicts(evidence);
  return Object.freeze({
    version: AUTHORITATIVE_EVIDENCE_VERSION,
    tenantId,
    agentId,
    callId: input.callId,
    fusion,
    evidence: verifiedRecords,
    verifiedRecords,
    ambiguity,
    conflict,
    rejectedRecordIds: Object.freeze(rejectedRecordIds),
    reservations: Object.freeze(reservedCandidates.map((entry) => {
      const fused = fusion.candidates.find((candidate) => recordKey(candidate) === recordKey(entry));
      const scoped = {
        tenantId,
        knowledgeBaseId: fused?.knowledgeBaseId ?? entry.knowledgeBaseId,
        publicationRevision: fused?.publicationRevision ?? entry.publicationRevision,
        recordId: String(entry.recordId),
        recordType: String(entry.recordType).toUpperCase(),
      };
      return Object.freeze({
        ...scoped,
        namespace: recordNamespaces[scoped.recordType] ?? 'UNKNOWN',
        canonicalIdentityKey: canonicalRecordIdentityKey(scoped),
        reason: String(entry.reason ?? 'reserved'),
      });
    })),
    comparisonCoverage: Object.freeze({
      requestedRecordIds: fusion.reservedRecordIds,
      requestedRecordKeys: fusion.reservedRecordKeys,
      missingRecordIds: Object.freeze(missingComparisonRecordIds),
      missingRecordKeys: Object.freeze(missingComparisonRecordKeys),
      complete: missingComparisonRecordKeys.length === 0,
    }),
    hydrationQueryCount: fusion.candidates.length ? 1 : 0,
  });
}
