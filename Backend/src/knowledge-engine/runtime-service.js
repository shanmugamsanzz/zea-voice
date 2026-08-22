import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { redis } from '../infrastructure/redis.js';
import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { requireTenantId } from '../rag/tenant-isolation.js';
import {
  answerCardsCacheKey, entityIndexCacheKey, evidenceCacheKey, knowledgeMapCacheKey,
  publicationManifestCacheKey, routeIndexCacheKey, sparseIndexCacheKey,
  tenantKnowledgeGenerationCacheKey,
} from '../knowledge-bases/knowledge-map.service.js';
import { KNOWLEDGE_PUBLICATION_BUNDLE_VERSION } from './publication-index-builder.js';
import {
  createKnowledgeEngineInput, isKnowledgeEngineInput, technicalClarificationDecision,
} from './engine-contract.js';
import { runObservedKnowledgeTurn } from './voice-turn-latency.js';

export const KNOWLEDGE_ENGINE_RUNTIME_VERSION = 1;

const activePublicationSql = `
  SELECT kb.id AS knowledge_base_id, kb.publication_revision, assignment.priority
    FROM voice_agents agent
    JOIN agent_knowledge_bases assignment
      ON assignment.tenant_id=agent.tenant_id AND assignment.agent_id=agent.id
    JOIN knowledge_bases kb
      ON kb.tenant_id=assignment.tenant_id AND kb.id=assignment.knowledge_base_id
   WHERE agent.tenant_id=$1 AND agent.id=$2
     AND agent.status='active' AND agent.deleted_at IS NULL
     AND kb.status='published' AND kb.deleted_at IS NULL AND kb.publication_revision>0
     AND (agent.usage_direction='both' OR agent.usage_direction=$3::agent_usage_direction)
     AND (assignment.usage_direction='both' OR assignment.usage_direction=$3::agent_usage_direction)
     AND (kb.usage_direction='both' OR kb.usage_direction=$3::agent_usage_direction)
     AND EXISTS (
       SELECT 1 FROM knowledge_processing_jobs job
        WHERE job.tenant_id=kb.tenant_id AND job.knowledge_base_id=kb.id
          AND job.job_type='index' AND job.status='completed'
          AND job.metadata->>'publicationRevision'=kb.publication_revision::text
     )
   ORDER BY assignment.priority,kb.id`;

const defaults = Object.freeze({ cache: redis, contextRunner: withTenantContext });

function normalizeId(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function unavailable(code, details = {}) {
  return new AppError(503, 'Published knowledge indexes are unavailable', code, details);
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(unavailable('KNOWLEDGE_INDEX_TIMEOUT')), timeoutMs);
    timer.unref?.();
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

async function readJson(cache, key) {
  if (!cache || (cache.status && cache.status !== 'ready')) {
    throw unavailable('KNOWLEDGE_INDEX_CACHE_UNAVAILABLE');
  }
  const raw = await settleWithin(cache.get(key), env.RAG_RUNTIME_CACHE_TIMEOUT_MS);
  if (!raw) throw unavailable('KNOWLEDGE_PUBLICATION_ARTIFACT_MISSING', { key });
  try { return JSON.parse(raw); }
  catch { throw unavailable('KNOWLEDGE_PUBLICATION_ARTIFACT_INVALID', { key }); }
}

function assertScope(artifact, identity, label) {
  if (Number(artifact?.version) !== KNOWLEDGE_PUBLICATION_BUNDLE_VERSION
    || normalizeId(artifact?.tenantId) !== normalizeId(identity.tenantId)
    || normalizeId(artifact?.knowledgeBaseId) !== normalizeId(identity.knowledgeBaseId)
    || Number(artifact?.publicationRevision) !== Number(identity.publicationRevision)) {
    throw unavailable('KNOWLEDGE_PUBLICATION_SCOPE_MISMATCH', { label, identity });
  }
}

function publicationRecord(record, answerCards) {
  const recordId = String(record.id ?? record.recordId ?? '').trim();
  const recordType = String(record.type ?? record.recordType ?? '').toLocaleLowerCase();
  const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
  const answerCard = answerCards.get(normalizeId(recordId)) ?? record.answerCard ?? null;
  return Object.freeze({
    record_id: recordId, record_type: recordType,
    document_id: record.documentId, document_version_id: record.documentVersionId,
    language: record.language ?? 'und', usage_direction: record.usageDirection ?? 'both',
    question: recordType === 'faq' ? record.label : null,
    answer: answerCard?.text ?? record.summary, content: record.summary ?? answerCard?.text,
    entity_name: record.label, entity_category: record.category,
    entity_aliases: record.aliases ?? [],
    entity_category_aliases: metadata.categoryAliases ?? [], entity_metadata: metadata,
    publicationAliases: record.aliases ?? [], publicationSttForms: record.sttForms ?? [],
    publicationPhoneticForms: record.phoneticForms ?? [], approvedAnswerCard: answerCard,
  });
}

async function loadArtifacts(identity, cache) {
  const args = [identity.tenantId, identity.knowledgeBaseId, identity.publicationRevision];
  const [map, sparse, evidence, entity, route, answers, manifest] = await Promise.all([
    readJson(cache, knowledgeMapCacheKey(...args)), readJson(cache, sparseIndexCacheKey(...args)),
    readJson(cache, evidenceCacheKey(...args)), readJson(cache, entityIndexCacheKey(...args)),
    readJson(cache, routeIndexCacheKey(...args)), readJson(cache, answerCardsCacheKey(...args)),
    readJson(cache, publicationManifestCacheKey(...args)),
  ]);
  for (const [label, artifact] of Object.entries({ map, sparse, evidence, entity, route, answers, manifest })) {
    assertScope(artifact, identity, label);
  }
  if (Number(manifest.recordCount) !== Number(evidence.records?.length ?? -1)) {
    throw unavailable('KNOWLEDGE_PUBLICATION_INCOMPLETE', { identity });
  }
  const cards = new Map((answers.records ?? []).map((card) => [normalizeId(card.recordId), card]));
  return Object.freeze({
    bundle: Object.freeze({
      version: KNOWLEDGE_PUBLICATION_BUNDLE_VERSION, ...identity,
      records: Object.freeze((evidence.records ?? []).map((record) => publicationRecord(record, cards))),
      answerCards: Object.freeze([...cards.values()]), entityIndex: Object.freeze(entity),
      routeIndex: Object.freeze(route), manifest: Object.freeze(manifest),
    }),
    sparseIndex: Object.freeze(sparse), map: Object.freeze(map),
  });
}

async function activePublications(auth, input, runtime) {
  const tenantId = requireTenantId(auth.tenantId);
  return runtime.contextRunner(auth, async (client) => {
    const result = await client.query(activePublicationSql, [tenantId, input.agentId, input.usageDirection]);
    return result.rows.map((row) => Object.freeze({
      tenantId, knowledgeBaseId: String(row.knowledge_base_id),
      publicationRevision: Number(row.publication_revision), priority: Number(row.priority ?? 100),
    }));
  });
}

export async function loadPublishedEngineArtifacts(auth, input, dependencies = {}) {
  const runtime = { ...defaults, ...dependencies };
  const publications = await activePublications(auth, input, runtime);
  if (!publications.length) throw unavailable('KNOWLEDGE_PUBLICATION_NOT_ASSIGNED', {
    tenantId: auth.tenantId,
    agentId: input.agentId,
    usageDirection: input.usageDirection,
  });
  const artifacts = await Promise.all(publications.map((identity) => loadArtifacts(identity, runtime.cache)));
  return Object.freeze({
    publications: Object.freeze(publications),
    bundles: Object.freeze(artifacts.map((entry) => entry.bundle)),
    sparseIndexes: Object.freeze(artifacts.map((entry) => entry.sparseIndex)),
    maps: Object.freeze(artifacts.map((entry) => entry.map)),
  });
}

function publicationRevisions(publications = []) {
  return Object.freeze(publications.map((publication) => Object.freeze({
    knowledgeBaseId: publication.knowledgeBaseId,
    publicationRevision: publication.publicationRevision,
  })));
}

function publicResult(observed, publications) {
  const evidence = observed.authoritative.evidence ?? [];
  return Object.freeze({
    operation: 'knowledge_engine_runtime', engineVersion: KNOWLEDGE_ENGINE_RUNTIME_VERSION,
    route: 'knowledge_engine', found: evidence.length > 0, decision: observed.decision,
    sources: Object.freeze(evidence.filter((source) => source.callerFacing === true)),
    actionEvidence: Object.freeze(evidence.filter((source) => source.recordType === 'WORKFLOW_RULE')),
    guidanceEvidence: Object.freeze(evidence.filter((source) => (
      source.recordType === 'CONVERSATION_NODE' && source.callerFacing === false
    ))),
    entities: Object.freeze(evidence.filter((source) => source.recordType === 'CATALOG_ITEM')
      .map((source) => ({
        id: source.recordId, key: source.authoritativeData?.itemKey ?? null,
        name: source.authoritativeData?.name ?? null,
        category: source.authoritativeData?.category ?? null,
        categoryKey: source.authoritativeData?.categoryKey ?? null,
      }))),
    evidenceIds: Object.freeze(evidence.map((source) => source.id)),
    // Publication availability is independent of whether this particular
    // utterance produced a ranked candidate. Reporting only candidate
    // revisions made healthy assigned publications look unavailable.
    publicationRevisions: publicationRevisions(publications),
    retrieval: Object.freeze({
      candidateCount: observed.retrieval.candidateCount,
      searchedIndexes: observed.retrieval.searchedIndexes,
      channels: Object.freeze(Object.fromEntries(Object.entries(observed.retrieval.channels)
        .map(([channel, candidates]) => [channel, candidates.length]))),
      conflictDetected: observed.authoritative.conflict.detected,
      ambiguityDetected: observed.authoritative.ambiguity.detected,
    }),
    latency: observed.latency, classification: observed.classification,
    resolution: observed.resolution, authoritative: observed.authoritative,
  });
}

export async function retrieveTenantEvidence(auth, input, dependencies = {}) {
  if (!isKnowledgeEngineInput(input)) {
    throw new AppError(400, 'A versioned knowledge-engine input is required', 'KNOWLEDGE_ENGINE_INPUT_INVALID');
  }
  let artifacts = null;
  try {
    artifacts = await loadPublishedEngineArtifacts(auth, input, dependencies);
    const observed = await runObservedKnowledgeTurn({
      auth, input, publicationBundles: artifacts.bundles,
      sparseIndexes: artifacts.sparseIndexes, runtimeProfile: dependencies.runtimeProfile,
      tracker: dependencies.tracker,
    }, {
      retrievalDependencies: dependencies.retrievalDependencies,
      hydrationDependencies: { contextRunner: dependencies.contextRunner ?? withTenantContext },
      cancelRetrieval: dependencies.cancelRetrieval, cancelHydration: dependencies.cancelHydration,
    });
    return publicResult(observed, artifacts.publications);
  } catch (error) {
    if (dependencies.throwOnError === true) throw error;
    const diagnostic = Object.freeze({
      stage: 'knowledge.engine_unavailable',
      errorCode: error.code ?? 'KNOWLEDGE_ENGINE_UNAVAILABLE',
      tenantId: auth.tenantId,
      agentId: input.agentId,
      callId: input.callId,
      usageDirection: input.usageDirection,
      publicationRevisions: publicationRevisions(artifacts?.publications),
      details: error.details ?? null,
    });
    logger.error({ err: error, ...diagnostic }, 'Knowledge engine could not load authoritative evidence');
    return Object.freeze({
      operation: 'knowledge_engine_runtime', route: 'knowledge_engine', found: false,
      cancelled: input.abortSignal?.aborted === true,
      error: error.code ?? 'KNOWLEDGE_ENGINE_UNAVAILABLE', sources: Object.freeze([]),
      actionEvidence: Object.freeze([]), guidanceEvidence: Object.freeze([]),
      entities: Object.freeze([]), decision: technicalClarificationDecision(
        input.abortSignal?.aborted ? 'knowledge_cancelled' : (error.code ?? 'knowledge_engine_unavailable'),
      ),
      publicationRevisions: diagnostic.publicationRevisions,
      diagnostic,
    });
  }
}

export const searchPublishedKnowledgeOperation = Object.freeze({
  name: 'search_published_knowledge',
  description: 'Search current published knowledge assigned to this agent.',
  inputSchema: Object.freeze({
    type: 'object', additionalProperties: false,
    properties: Object.freeze({
      semanticQuery: Object.freeze({ type: 'string', minLength: 1, maxLength: 2_000 }),
      requestedFacts: Object.freeze({
        type: 'array', maxItems: 20,
        items: Object.freeze({ type: 'string', minLength: 1, maxLength: 120 }),
      }),
    }), required: Object.freeze(['semanticQuery']),
  }),
});

function adaptInput(auth, input, prefix) {
  if (isKnowledgeEngineInput(input)) return input;
  return createKnowledgeEngineInput({
    tenantId: auth.tenantId, agentId: input.agentId,
    callId: input.callId ?? `${prefix}-${randomUUID()}`,
    utterance: input.query ?? input.semanticQuery ?? 'published knowledge map',
    usageDirection: input.usageDirection, language: input.language,
    requestedFacts: input.requestedFacts,
    memory: {
      activeEntity: input.activeEntity, activeCategory: input.activeCategory,
      latestIntent: input.detectedIntent?.intent, recentConversation: input.recentTurns,
      pendingClarification: input.pendingClarification, knownEntities: input.knownEntities,
      pendingQuestion: input.pendingQuestion, collectedInformation: input.collectedInformation,
    },
  });
}

export function searchPublishedKnowledge(auth, input, dependencies = {}) {
  return retrieveTenantEvidence(auth, adaptInput(auth, input, 'search'), dependencies);
}

export async function loadPublishedKnowledgeMap(auth, input, dependencies = {}) {
  const engineInput = adaptInput(auth, input, 'map');
  const artifacts = await loadPublishedEngineArtifacts(auth, engineInput, dependencies);
  return Object.freeze({
    found: artifacts.maps.some((map) => (map.records ?? []).length > 0),
    route: 'published_knowledge_map', maps: artifacts.maps,
    records: Object.freeze(artifacts.maps.flatMap((map) => map.records ?? [])),
    knowledgeBases: artifacts.publications,
  });
}

async function invalidate(tenantId, cache, includeArtifacts) {
  const tenant = requireTenantId(tenantId);
  if (!cache || (cache.status && cache.status !== 'ready')) return { deletedKeys: 0, incomplete: true };
  if (!includeArtifacts) return { deletedKeys: 0, verified: true, remainingKeys: 0 };
  const patterns = [
    `zea:rag:knowledge-map:${tenant}:*`, `zea:rag:bm25:${tenant}:*`,
    `zea:rag:evidence:${tenant}:*`, `zea:rag:entity-index:${tenant}:*`,
    `zea:rag:route-index:${tenant}:*`, `zea:rag:answer-cards:${tenant}:*`,
    `zea:rag:publication-manifest:${tenant}:*`, tenantKnowledgeGenerationCacheKey(tenant),
  ];
  let deletedKeys = 0;
  try {
    for (const pattern of patterns) {
      if (!pattern.includes('*')) {
        deletedKeys += Number(await cache.del(pattern) ?? 0);
        continue;
      }
      let cursor = '0';
      do {
        const response = await cache.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = String(response?.[0] ?? '0');
        const keys = Array.isArray(response?.[1]) ? response[1] : [];
        if (keys.length) deletedKeys += Number(await cache.del(...keys) ?? 0);
      } while (cursor !== '0');
    }
  } catch { return { deletedKeys, incomplete: true }; }
  return { deletedKeys, verified: true, remainingKeys: 0 };
}

export function invalidateTenantKnowledgeCache(tenantId, cache = redis) {
  return invalidate(tenantId, cache, true);
}

export function invalidateTenantRuntimeKnowledgeCache(tenantId, cache = redis) {
  return invalidate(tenantId, cache, false);
}
