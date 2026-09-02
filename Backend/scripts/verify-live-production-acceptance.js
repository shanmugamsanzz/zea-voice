import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { withPlatformAdminContext } from '../src/infrastructure/database-context.js';
import { closeDatabase } from '../src/infrastructure/database.js';
import { retrieveTenantEvidence } from '../src/knowledge-bases/knowledge-runtime.service.js';
import { loadAgentRuntimeProfile } from '../src/voice/providers/provider-config.js';
import { createSelectedLlmStream, runtimeTools } from '../src/voice/providers/llm/llm-response.service.js';
import {
  compactIsolatedCallMemory, openIsolatedCallMemory,
} from '../src/knowledge-engine/call-memory.js';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';
import { isRepairableGroundedDecisionReason } from '../src/voice/interaction/grounded-llm-decision.js';
import { applyUnifiedGroundedTurn } from '../src/voice/interaction/unified-grounded-turn.js';
import { evidenceBelongsToRuntime } from '../src/voice/interaction/grounded-decision-security.js';
import {
  configuredSafeFailureResponse,
  configuredTechnicalFailureResponse,
} from '../src/voice/realtime-conversation-orchestrator.js';
import { streamSelectedTtsToPlivo } from '../src/voice/providers/tts/tts-playback.service.js';
import { ProviderAdapterRegistry } from '../src/voice/providers/registry.js';
import { registerImplementedProviderAdapters } from '../src/voice/providers/defaults.js';
import { runtimeReleaseMetadata } from '../src/release/runtime-release-metadata.js';
import { countTenantPointsByKnowledgeBaseRevision } from '../src/rag/qdrant.client.js';
import {
  createKnowledgeEngineInput,
  isKnowledgeEngineDecision,
  knowledgeEngineDecisionTypes,
  knowledgeEngineResponseModes,
} from '../src/knowledge-engine/engine-contract.js';

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function required(value, name) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function enabled(value) {
  return ['1', 'true', 'yes'].includes(String(value ?? '').trim().toLocaleLowerCase());
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
}

function catalogAttributeKeys(source) {
  return new Set((source?.authoritativeData?.attributes ?? []).map((attribute) => (
    normalized(attribute?.key ?? attribute?.name)
  )).filter(Boolean));
}

function sourceRecordId(source) {
  return String(source?.recordId ?? source?.id ?? '').trim();
}

function canonicalItemKey(source) {
  return normalized(source?.authoritativeData?.itemKey);
}

function numericValues(value, results = []) {
  if (typeof value === 'number' && Number.isFinite(value)) results.push(value);
  else if (typeof value === 'string' && /^\s*\d[\d,]*(?:\.\d+)?\s*$/u.test(value)) {
    results.push(Number(value.replaceAll(',', '').trim()));
  }
  else if (Array.isArray(value)) value.forEach((entry) => numericValues(entry, results));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => numericValues(entry, results));
  }
  return results;
}

function spokenNumbers(value) {
  return [...String(value ?? '').matchAll(/\d[\d,]*/gu)]
    .map((match) => Number(match[0].replaceAll(',', ''))).filter(Number.isFinite);
}

const allowedEvidenceTypes = new Set([
  'CATALOG_ITEM', 'WORKFLOW_RULE', 'CONVERSATION_NODE', 'FAQ', 'KNOWLEDGE_CHUNK',
]);

function expectedRevisionMap(value) {
  const entries = String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  assert.ok(entries.length > 0,
    'Explicit --expected-revisions=<knowledgeBaseId>:<revision>[,...] is required');
  const result = new Map();
  for (const entry of entries) {
    const separator = entry.lastIndexOf(':');
    assert.ok(separator > 0, `Invalid expected revision entry: ${entry}`);
    const knowledgeBaseId = entry.slice(0, separator).trim().toLowerCase();
    const revision = Number(entry.slice(separator + 1));
    assert.match(knowledgeBaseId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      `Invalid Knowledge Base ID: ${knowledgeBaseId}`);
    assert.ok(Number.isInteger(revision) && revision > 0, `Invalid revision: ${entry}`);
    assert.equal(result.has(knowledgeBaseId), false, `Duplicate Knowledge Base revision: ${knowledgeBaseId}`);
    result.set(knowledgeBaseId, revision);
  }
  return result;
}

function revisionFingerprint(revisions) {
  return revisions.map((entry) => (
    `${String(entry.knowledgeBaseId).toLowerCase()}:${Number(entry.publicationRevision)}`
  )).sort().join('|');
}

function matchingCatalogSources(hydrated, turn) {
  const entityKeys = new Set((turn.expectedAnyEntityKeys ?? []).map(normalized));
  const categoryKeys = new Set((turn.expectedAnyCategoryKeys ?? []).map(normalized));
  return hydrated.filter((source) => {
    if (String(source?.recordType ?? '').toUpperCase() !== 'CATALOG_ITEM') return false;
    const data = source.authoritativeData ?? {};
    return entityKeys.has(normalized(data.itemKey)) || categoryKeys.has(normalized(data.categoryKey));
  });
}

function verifyTurnExpectations({
  call, index, turn, tenantEvidence, hydrated, envelope, selectedRecordIds,
  responseId, finalText, finalDecision, safeResponse, memoryState, memoryBefore, groundedStateUpdate,
  recordAliases,
}) {
  const label = `${call.id} turn ${index + 1}`;
  const catalogSources = matchingCatalogSources(hydrated, turn);
  if ((turn.expectedAnyEntityKeys?.length ?? 0) > 0) {
    assert.ok(catalogSources.length > 0, `${label}: expected Catalog item was not hydrated`);
  }
  if ((turn.expectedAnyCategoryKeys?.length ?? 0) > 0) {
    assert.ok(catalogSources.length > 0, `${label}: expected Catalog category was not hydrated`);
  }
  if (catalogSources.length > 0) {
    const catalogRecordIds = new Set(catalogSources.map(sourceRecordId));
    const citationDiagnostic = JSON.stringify({
      expectedCatalogRecordIds: [...catalogRecordIds],
      selectedRecordIds,
      envelopeSources: (envelope?.sources ?? []).map((source) => ({
        id: source.id,
        recordId: sourceRecordId(source),
        recordType: source.recordType,
        itemKey: source.authoritativeData?.itemKey ?? null,
        categoryKey: source.authoritativeData?.categoryKey ?? null,
        retrievalContext: source.retrievalContext ?? null,
        channels: source.channels ?? [],
      })),
      memory: {
        selectedItemKey: memoryState.selectedCatalogItem?.key
          ?? memoryState.selectedItem?.key ?? null,
        knownEntityKeys: (memoryState.knownEntities ?? []).map((entity) => entity?.key),
      },
    });
    if (finalDecision === 'clarify' && turn.allowTargetedClarification === true) {
      assert.ok(catalogSources.every((source) => (
        (turn.expectedAnyCategoryKeys ?? []).map(normalized)
          .includes(normalized(source.authoritativeData?.categoryKey))
      )), `${label}: clarification candidates are not isolated to the expected category`);
    } else {
      assert.ok(selectedRecordIds.some((id) => catalogRecordIds.has(id)),
        `${label}: grounded decision did not cite the expected Catalog evidence ${citationDiagnostic}`);
    }
  }
  if (turn.rememberRecordAs) {
    const recordIds = [...new Set(catalogSources.map(sourceRecordId).filter(Boolean))];
    assert.equal(recordIds.length, 1, `${label}: record alias requires exactly one Catalog item`);
    assert.equal(sourceRecordId(memoryState.activeEntity), recordIds[0],
      `${label}: canonical memory did not store the selected PostgreSQL record ID`);
    recordAliases.set(String(turn.rememberRecordAs), recordIds[0]);
  }
  if (turn.expectedSameRecordAs) {
    const expectedRecordId = recordAliases.get(String(turn.expectedSameRecordAs));
    assert.ok(expectedRecordId, `${label}: expected record alias was not established`);
    assert.ok(catalogSources.some((source) => sourceRecordId(source) === expectedRecordId),
      `${label}: contextual follow-up did not hydrate the remembered PostgreSQL record`);
    assert.equal(sourceRecordId(memoryState.activeEntity), expectedRecordId,
      `${label}: canonical active memory does not contain the remembered record ID`);
  }
  if (turn.expectedActiveEntityKey) {
    assert.equal(normalized(memoryState.activeEntity?.key), normalized(turn.expectedActiveEntityKey),
      `${label}: active canonical entity was not replaced correctly`);
  }
  if (turn.expectedPriceAmount !== undefined) {
    const expectedPrice = Number(turn.expectedPriceAmount);
    assert.ok(catalogSources.some((source) => (
      numericValues(source.authoritativeData).includes(expectedPrice)
    )), `${label}: authoritative Catalog evidence does not contain the expected price`);
    assert.ok(spokenNumbers(finalText).includes(expectedPrice),
      `${label}: grounded answer did not return the expected published price`);
  }
  if ((turn.expectedExactCatalogEntityKeys?.length ?? 0) > 0) {
    const expectedKeys = new Set(turn.expectedExactCatalogEntityKeys.map(normalized));
    const actualKeys = new Set(hydrated.filter((source) => (
      String(source?.recordType ?? '').toUpperCase() === 'CATALOG_ITEM'
    )).map(canonicalItemKey).filter(Boolean));
    assert.deepEqual(actualKeys, expectedKeys, `${label}: unrelated Catalog evidence entered the turn`);
    const expectedIds = new Set(hydrated.filter((source) => (
      expectedKeys.has(canonicalItemKey(source))
    )).map(sourceRecordId));
    const comparisonIds = new Set((tenantEvidence.authoritative?.reservations ?? [])
      .filter((entry) => entry.reason === 'explicit_comparison').map(sourceRecordId));
    assert.deepEqual(comparisonIds, expectedIds,
      `${label}: comparison did not reserve exactly the requested PostgreSQL records`);
  }
  if (turn.requireNoUnrelatedEvidence === true) {
    const allowedKeys = new Set([
      ...(turn.expectedAnyEntityKeys ?? []),
      ...(turn.expectedExactCatalogEntityKeys ?? []),
    ].map(normalized));
    const allowedCategoryKeys = new Set(
      (turn.expectedAnyCategoryKeys ?? []).map(normalized),
    );
    const unrelated = hydrated.filter((source) => source.callerFacing === true).filter((source) => (
      !(
        String(source.recordType).toUpperCase() === 'CATALOG_ITEM'
          && (allowedKeys.has(canonicalItemKey(source))
            || allowedCategoryKeys.has(normalized(source.authoritativeData?.categoryKey)))
      )
      && !(
        String(source.recordType).toUpperCase() === 'CATALOG_CATEGORY'
          && allowedCategoryKeys.has(normalized(source.authoritativeData?.categoryKey))
      )
    ));
    assert.deepEqual(unrelated.map((source) => ({
      recordId: sourceRecordId(source), recordType: source.recordType,
    })), [], `${label}: unrelated caller-facing evidence entered the LLM envelope`);
  }
  for (const source of catalogSources) {
    const data = source.authoritativeData ?? {};
    for (const field of turn.requiredCatalogFields ?? []) {
      assert.ok(Object.hasOwn(data, field), `${label}: hydrated Catalog record is missing ${field}`);
    }
  }
  for (const expectedAttribute of turn.requiredCatalogAttributes ?? []) {
    assert.ok(catalogSources.some((source) => catalogAttributeKeys(source).has(normalized(expectedAttribute))),
      `${label}: hydrated Catalog record is missing ${expectedAttribute}`);
  }
  if (turn.expectedMemoryEntityKey) {
    const memoryDiagnostic = JSON.stringify({
      expectedMemoryEntityKey: turn.expectedMemoryEntityKey,
      before: {
        currentTopic: memoryBefore?.currentTopic ?? null,
        knownEntities: (memoryBefore?.knownEntities ?? []).map((entity) => ({
          id: entity?.id ?? null, key: entity?.key ?? null, name: entity?.name ?? null,
        })),
      },
      retrieval: {
        catalogIdentityResolution: tenantEvidence?.retrieval?.catalogIdentityResolution ?? null,
        explicitCatalogRecordIds: tenantEvidence?.retrieval?.explicitCatalogRecordIds ?? [],
        contextualUsed: tenantEvidence?.retrieval?.contextualUsed ?? false,
        contextualPreferred: tenantEvidence?.retrieval?.contextualPreferred ?? false,
      },
      hydratedCatalog: (hydrated ?? []).filter((source) => (
        String(source?.recordType ?? '').toUpperCase() === 'CATALOG_ITEM'
      )).map((source) => ({
        id: source.id ?? null, recordId: sourceRecordId(source),
        itemKey: source.authoritativeData?.itemKey ?? null,
        categoryKey: source.authoritativeData?.categoryKey ?? null,
        retrievalContext: source.retrievalContext ?? null,
        channels: source.channels ?? [],
      })),
      envelopeSources: (envelope?.sources ?? []).map((source) => ({
        id: source.id, recordId: sourceRecordId(source), recordType: source.recordType,
        itemKey: source.authoritativeData?.itemKey ?? null,
      })),
      decision: {
        responseId, selectedRecordIds, stateUpdate: groundedStateUpdate ?? null,
      },
      after: {
        currentTopic: memoryState.currentTopic ?? null,
        knownEntities: (memoryState.knownEntities ?? []).map((entity) => ({
          id: entity?.id ?? null, key: entity?.key ?? null, name: entity?.name ?? null,
        })),
        requestType: memoryState.requestType ?? null,
        contextDependent: memoryState.contextDependent === true,
      },
    });
    assert.ok((memoryState.knownEntities ?? []).some((entity) => (
      normalized(entity?.key) === normalized(turn.expectedMemoryEntityKey)
    )), `${label}: selected follow-up entity was not preserved in memory ${memoryDiagnostic}`);
  }
  if ((turn.expectedResponseNodeKeys?.length ?? 0) > 0) {
    const expectedKeys = new Set(turn.expectedResponseNodeKeys.map(normalized));
    const directRecordId = tenantEvidence.decision?.type === knowledgeEngineDecisionTypes.RESPONSE
      && tenantEvidence.decision?.mode === knowledgeEngineResponseModes.DETERMINISTIC
      ? tenantEvidence.decision.response?.recordId : null;
    const direct = (tenantEvidence.sources ?? []).find((source) => (
      source.recordId === directRecordId
    )) ?? null;
    const selectedPublishedResponse = (envelope?.sources ?? [])
      .find((source) => source.id === responseId) ?? null;
    const resolvedPublishedResponse = direct ?? selectedPublishedResponse;
    const responseDiagnostic = JSON.stringify({
      responseId,
      directNodeKey: direct?.authoritativeData?.nodeKey ?? null,
      catalogIdentityResolution: tenantEvidence?.retrieval?.catalogIdentityResolution ?? null,
      conversationRouting: tenantEvidence?.retrieval?.conversationRouting ?? null,
      sources: (envelope?.sources ?? []).map((source) => ({
        id: source.id,
        recordType: source.recordType,
        nodeKey: source.authoritativeData?.nodeKey ?? null,
        exactCallerResponse: source.exactCallerResponse === true,
        retrievalContext: source.retrievalContext ?? null,
        score: source.score ?? null,
      })),
    });
    assert.ok(resolvedPublishedResponse
      && expectedKeys.has(normalized(resolvedPublishedResponse.authoritativeData?.nodeKey)),
    `${label}: expected caller-facing published response was not selected by retrieval or grounded decision ${responseDiagnostic}`);
    if (turn.requireExactPublishedResponse === true) {
      assert.ok(responseId, `${label}: exact published responseId was not selected`);
      const exactSource = selectedPublishedResponse;
      assert.ok(exactSource?.callerFacing === true,
        `${label}: responseId does not identify caller-facing published evidence`);
      if (direct) {
        assert.equal(exactSource?.recordId, direct.recordId,
          `${label}: responseId does not identify the directly matched published response`);
      }
      assert.equal(finalText, exactSource.content,
        `${label}: final TTS text did not preserve the published RESPONSE exactly`);
    }
  }
  const usedSafeResponse = normalized(finalText) === normalized(safeResponse);
  if (turn.allowSafeResponse === true) {
    assert.equal(usedSafeResponse, true, `${label}: configured safe response was expected`);
    assert.equal(selectedRecordIds.length, 0, `${label}: safe fallback must not cite an unrelated record`);
  } else {
    assert.equal(usedSafeResponse, false, `${label}: answerable turn used the generic safe response`);
  }
  return Object.freeze({
    expectedCatalogRecordIds: catalogSources.map(sourceRecordId),
    usedSafeResponse,
    exactPublishedResponse: turn.requireExactPublishedResponse === true,
  });
}

async function resolveAgent(agentId) {
  return withPlatformAdminContext(null, async (client) => {
    const result = await client.query(
      `SELECT id, tenant_id, workspace_id, usage_direction
         FROM voice_agents
        WHERE id=$1 AND status='active' AND deleted_at IS NULL`,
      [agentId],
    );
    assert.equal(result.rowCount, 1, 'The production acceptance agent must be active');
    return result.rows[0];
  });
}

async function verifyCandidateRevisions(agent, expected) {
  const rows = await withPlatformAdminContext(null, async (client) => {
    const result = await client.query(
      `SELECT kb.id AS knowledge_base_id, kb.status, kb.publication_revision,
          kb.pending_publication_revision,
          EXISTS (
            SELECT 1 FROM knowledge_processing_jobs j
             WHERE j.tenant_id=kb.tenant_id AND j.knowledge_base_id=kb.id
               AND j.job_type='index' AND j.status='completed'
               AND j.metadata->>'publicationRevision'=kb.publication_revision::text
          ) AS completed_index
         FROM agent_knowledge_bases akb
         JOIN knowledge_bases kb
           ON kb.tenant_id=akb.tenant_id AND kb.id=akb.knowledge_base_id
        WHERE akb.tenant_id=$1 AND akb.agent_id=$2
          AND kb.deleted_at IS NULL
        ORDER BY akb.priority, kb.id`,
      [agent.tenant_id, agent.id],
    );
    return result.rows;
  });
  const byId = new Map(rows.map((row) => [String(row.knowledge_base_id).toLowerCase(), row]));
  const verified = [];
  for (const [knowledgeBaseId, revision] of expected) {
    const row = byId.get(knowledgeBaseId);
    assert.ok(row, `Expected Knowledge Base ${knowledgeBaseId} is not assigned to the agent`);
    assert.equal(row.status, 'published', `${knowledgeBaseId} is not atomically published`);
    assert.equal(Number(row.publication_revision), revision,
      `${knowledgeBaseId} active revision does not match the activation candidate`);
    assert.equal(row.pending_publication_revision, null,
      `${knowledgeBaseId} still has an unfinished PostgreSQL publication revision`);
    assert.equal(row.completed_index, true,
      `${knowledgeBaseId}:${revision} has no completed semantic index job`);
    const qdrant = await countTenantPointsByKnowledgeBaseRevision(
      agent.tenant_id, knowledgeBaseId, revision,
    );
    assert.ok(Number(qdrant.count) > 0,
      `${knowledgeBaseId}:${revision} has no Qdrant points`);
    verified.push({
      knowledgeBaseId, publicationRevision: revision,
      postgresPublished: true, qdrantPointCount: Number(qdrant.count),
    });
  }
  assert.equal(rows.length, expected.size,
    'Every Knowledge Base assigned to the activation candidate agent must be pinned explicitly');
  return verified;
}

async function verifyExtractionArtifacts(agent, expected) {
  const rows = await withPlatformAdminContext(null, async (client) => {
    const result = await client.query(
      `SELECT d.knowledge_base_id, d.id AS document_id, d.status AS document_status,
          v.id AS document_version_id, v.status AS version_status, v.is_current,
          v.extracted_text_object_key, v.extraction_metadata
         FROM knowledge_documents d
         JOIN knowledge_document_versions v
           ON v.tenant_id=d.tenant_id AND v.knowledge_base_id=d.knowledge_base_id
          AND v.document_id=d.id AND v.is_current=true
        WHERE d.tenant_id=$1 AND d.knowledge_base_id = ANY($2::uuid[])
          AND d.deleted_at IS NULL`,
      [agent.tenant_id, [...expected.keys()]],
    );
    return result.rows;
  });
  assert.ok(rows.length > 0, 'The release candidate has no real extracted source documents');
  for (const row of rows) {
    assert.equal(row.document_status, 'ready', `${row.document_id}: source document is not ready`);
    assert.equal(row.version_status, 'ready', `${row.document_id}: extracted version is not ready`);
    assert.equal(row.is_current, true, `${row.document_id}: extracted version is not current`);
    assert.ok(String(row.extracted_text_object_key ?? '').trim(),
      `${row.document_id}: real extracted-text artifact is missing`);
    assert.ok(row.extraction_metadata && Object.keys(row.extraction_metadata).length > 0,
      `${row.document_id}: extraction metadata is missing`);
  }
  return rows.map((row) => ({
    knowledgeBaseId: row.knowledge_base_id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    extracted: true,
  }));
}

async function synthesizeLiveTts(profile, text, registry) {
  let audioBytes = 0;
  let audioChunks = 0;
  const result = await streamSelectedTtsToPlivo(profile, text, {
    registry,
    audioEngine: {
      beginOutputGeneration() {},
      async enqueueSynthesized(audio) {
        audioBytes += audio.length;
        audioChunks += 1;
        return true;
      },
      async flushSynthesized() { return true; },
      cancelStaleAudio() {},
    },
  });
  assert.equal(result.cancelled, false, 'Live TTS synthesis was cancelled');
  assert.ok(audioBytes > 0 && audioChunks > 0, 'Live TTS returned no audio');
  return { audioBytes, audioChunks };
}

async function collectDecision(profile, input, registry) {
  const session = await createSelectedLlmStream(profile, input, {
    registry,
    skipDefaultRegistration: true,
  });
  let raw = '';
  try {
    for await (const event of session.events) {
      if (event.type === 'text_delta') raw += String(event.delta ?? '');
      else if (event.type === 'error') throw Object.assign(new Error(event.message), { code: event.code });
      else if (event.type === 'cancelled') throw new Error('Production acceptance LLM request was cancelled');
      else if (event.type === 'completed' && !raw) raw = String(event.answer ?? event.text ?? '');
    }
    return raw;
  } finally {
    await session.close?.();
  }
}

assert.equal(enabled(argument(
  'allow-live-transcript-processing', process.env.PRODUCTION_ACCEPTANCE_ALLOW_LIVE_TRANSCRIPTS,
)), true, 'Explicit --allow-live-transcript-processing=true authorization is required');
const agentId = required(
  argument('agent-id', process.env.PRODUCTION_ACCEPTANCE_AGENT_ID),
  'PRODUCTION_ACCEPTANCE_AGENT_ID or --agent-id',
);
const expectedRevisions = expectedRevisionMap(argument(
  'expected-revisions', process.env.PRODUCTION_ACCEPTANCE_EXPECTED_REVISIONS,
));
const requireLiveTts = enabled(argument(
  'require-live-tts', process.env.PRODUCTION_ACCEPTANCE_REQUIRE_LIVE_TTS,
));
const requireReleaseIdentity = enabled(argument('require-release-identity', false));
const expectedGitSha = argument(
  'expected-git-sha', process.env.PRODUCTION_ACCEPTANCE_EXPECTED_GIT_SHA,
);
const release = runtimeReleaseMetadata();
if (requireReleaseIdentity) {
  assert.match(String(expectedGitSha ?? ''), /^[0-9a-f]{40}$/iu,
    'A full --expected-git-sha is required for the production release gate');
  assert.equal(release.gitSha, expectedGitSha,
    'The running container Git SHA does not match the deployment candidate');
}
const replayPath = resolve(argument(
  'replay-file', process.env.PRODUCTION_ACCEPTANCE_REPLAY_FILE
    ?? 'fixtures/failed-call-2026-08-19-production.json',
));
const reportPath = resolve(argument(
  'report-file', process.env.PRODUCTION_ACCEPTANCE_REPORT
    ?? 'artifacts/production-acceptance-report.json',
));
let replay = JSON.parse(await readFile(replayPath, 'utf8'));
if (enabled(argument('include-live-routing-workflow', false))) {
  replay = {
    ...replay,
    calls: [...(replay.calls ?? []), {
      id: 'shanmuga-live-routing-workflow', language: 'ta', turns: [
        { utterance: 'உங்ககிட்ட என்ன packagesலாம் இருக்கு?', expectedResponseNodeKeys: ['complete_package_overview'], forbidConfiguredTechnicalFailure: true },
        { utterance: 'ஆன் cooker package பத்தி சொல்லுங்க', expectedAnyCategoryKeys: ['oncology-screening'], allowTargetedClarification: true, requireNoUnrelatedEvidence: true, forbidConfiguredTechnicalFailure: true },
        { utterance: 'Gold-க்கும் Platinum-க்கும் என்ன difference?', expectedExactCatalogEntityKeys: ['gold-master-health-checkup', 'platinum-master-health-checkup'], requireNoUnrelatedEvidence: true, forbidConfiguredTechnicalFailure: true },
        { utterance: 'அதுதான் என்ன வித்தியாசம்?', expectedExactCatalogEntityKeys: ['gold-master-health-checkup', 'platinum-master-health-checkup'], requireNoUnrelatedEvidence: true, forbidConfiguredTechnicalFailure: true },
        { utterance: 'Lungs package பத்தி சொல்லுங்க', expectedAnyEntityKeys: ['lungs-health-checkup'], expectedMemoryEntityKey: 'lungs-health-checkup', expectedActiveEntityKey: 'lungs-health-checkup', rememberRecordAs: 'lungs', requireNoUnrelatedEvidence: true, forbidConfiguredTechnicalFailure: true },
        { utterance: 'சரி இதுக்கு appointment book பண்ணுங்க', expectedAnyEntityKeys: ['lungs-health-checkup'], expectedSameRecordAs: 'lungs', expectedActiveToolName: 'create_appointment', expectFirstMissingConfiguredField: true, allowInformationCollection: true, requireNoUnrelatedEvidence: true, forbidConfiguredTechnicalFailure: true },
      ],
    }],
  };
}
assert.ok(Array.isArray(replay.calls) && replay.calls.length > 0, 'At least one failed call replay is required');
const repeats = Math.max(1, Number.parseInt(argument('repeats', '1'), 10) || 1);

const agent = await resolveAgent(agentId);
const candidateRevisions = await verifyCandidateRevisions(agent, expectedRevisions);
const extractionArtifacts = await verifyExtractionArtifacts(agent, expectedRevisions);
const candidateRevisionFingerprint = revisionFingerprint(candidateRevisions);
const direction = agent.usage_direction === 'outbound' ? 'outbound' : 'inbound';
const resolvedAgent = {
  agentId: agent.id, tenantId: agent.tenant_id, workspaceId: agent.workspace_id,
  callDirection: direction,
};
const profile = await loadAgentRuntimeProfile(resolvedAgent);
const auth = {
  tenantId: agent.tenant_id, workspaceId: agent.workspace_id,
  userId: null, role: 'COMPANY_DEVELOPER',
};
const tools = runtimeTools(profile.tools);
const samples = [];
const results = [];
let qdrantCandidates = 0;
const replayLanguages = new Set();
const safeResponse = configuredSafeFailureResponse(profile);
const technicalResponse = configuredTechnicalFailureResponse(profile);
const providerRegistry = registerImplementedProviderAdapters(new ProviderAdapterRegistry());

try {
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
   for (const call of replay.calls) {
    assert.ok(Array.isArray(call.turns) && call.turns.length > 0, `${call.id}: turns are required`);
    const callId = `production-acceptance:${call.id}:pass-${repeat}`;
    const memory = openIsolatedCallMemory({
      tenantId: agent.tenant_id, workspaceId: agent.workspace_id,
      agentId: agent.id, callId,
    }, profile.agent.settings, Date.now(), { language: profile.agent.language });
    const recordAliases = new Map();
    try {
      if (call.initialAssistantTurn) {
        memory.append({ role: 'assistant', content: String(call.initialAssistantTurn) });
      }
      if (call.initialPendingQuestion) {
        memory.setPendingQuestion({
          key: 'production-replay-initial-question',
          text: String(call.initialPendingQuestion), kind: 'conversation',
        });
      }
      for (const [index, turn] of call.turns.entries()) {
        const utterance = required(turn.utterance, `${call.id} turn ${index + 1} utterance`);
        const replayLanguage = required(turn.language ?? call.language,
          `${call.id} turn ${index + 1} language`)
          .toLocaleLowerCase();
        replayLanguages.add(replayLanguage);
        const totalStartedAt = performance.now();
        const retrievalStartedAt = performance.now();
        const snapshot = memory.snapshot();
        const tenantEvidence = await retrieveTenantEvidence(auth, createKnowledgeEngineInput({
          tenantId: auth.tenantId,
          agentId: agent.id,
          callId: call.id,
          utterance,
          usageDirection: direction,
          language: snapshot.language,
          memory: {
            activeEntity: snapshot.activeEntity,
            activeCategory: snapshot.activeCategory,
            knownEntities: snapshot.knownEntities,
            comparisonEntities: snapshot.comparisonEntities,
            recentConversation: snapshot.recentTurns,
            pendingQuestion: snapshot.pendingQuestion?.text ?? null,
            pendingClarification: snapshot.pendingClarification,
            latestIntent: snapshot.latestIntent,
            collectedInformation: snapshot.collectedInformation,
          },
        }));
        const retrievalMs = performance.now() - retrievalStartedAt;
        const publicationRevisions = tenantEvidence.publicationRevisions ?? [];
        assert.ok(publicationRevisions.length > 0, `${call.id} turn ${index + 1}: no active publication revision`);
        assert.equal(revisionFingerprint(publicationRevisions), candidateRevisionFingerprint,
          `${call.id} turn ${index + 1}: retrieval did not use the pinned activation candidate revision`);
        const activeRevisionByKnowledgeBase = new Map(publicationRevisions.map((revision) => (
          [normalized(revision.knowledgeBaseId), Number(revision.publicationRevision)]
        )));
        const retrievalTrace = tenantEvidence.retrievalTrace ?? {};
        for (const candidate of retrievalTrace.retrievedCandidates ?? []) {
          assert.ok(candidate.recordId, `${call.id} turn ${index + 1}: retrieved candidate has no record ID`);
          assert.ok(candidate.knowledgeBaseId,
            `${call.id} turn ${index + 1}: retrieved ${candidate.recordId} has no Knowledge Base ID`);
          assert.equal(Number(candidate.publicationRevision),
            activeRevisionByKnowledgeBase.get(normalized(candidate.knowledgeBaseId)),
            `${call.id} turn ${index + 1}: retrieved ${candidate.recordId} is from a stale revision`);
        }
        const hydrated = [
          ...(tenantEvidence.sources ?? []),
          ...(tenantEvidence.actionEvidence ?? []),
          ...(tenantEvidence.guidanceEvidence ?? []),
        ];
        assert.ok(hydrated.length > 0 || turn.allowSafeResponse === true,
          `${call.id} turn ${index + 1}: no hydrated evidence`);
        for (const source of hydrated) {
          assert.ok(source.recordId, `${call.id} turn ${index + 1}: evidence has no PostgreSQL record ID`);
          assert.ok(allowedEvidenceTypes.has(String(source.recordType).toUpperCase()),
            `${call.id} turn ${index + 1}: unsupported evidence type ${source.recordType}`);
        }
        const scope = {
          tenantId: agent.tenant_id, agentId: agent.id,
          publicationRevisions, requireHydratedEvidence: true,
        };
        for (const source of hydrated) {
          assert.equal(evidenceBelongsToRuntime(source, scope), true,
            `${call.id} turn ${index + 1}: foreign, stale or unhydrated evidence ${source.recordId}`);
        }
        const qdrantCandidateCount = Number(tenantEvidence.retrieval?.channels?.qdrant ?? 0);
        qdrantCandidates += qdrantCandidateCount;
        // Qdrant validates semantic discovery. Authoritative hydration may then
        // replace a matching category seed with complete PostgreSQL children;
        // those children must not inherit a fabricated vector score.
        const positiveSemanticCandidates = (retrievalTrace.retrievedCandidates ?? [])
          .filter((candidate) => Number(candidate.providerScores?.qdrant) > 0
            && (candidate.channels ?? []).includes('qdrant'));
        const directCanonicalMemory = (tenantEvidence.retrieval?.searchedIndexes ?? [])
          .includes('direct_canonical_memory');
        if (turn.allowSafeResponse !== true && !directCanonicalMemory) {
          assert.ok(qdrantCandidateCount > 0,
            `${call.id} turn ${index + 1}: semantic retrieval returned no candidates`);
          assert.ok(positiveSemanticCandidates.length > 0,
            `${call.id} turn ${index + 1}: semantic retrieval trace has no genuine non-zero score`);
        }
        const knowledge = {
          route: 'llm_first', found: tenantEvidence.found === true,
          content: tenantEvidence.sources?.[0]?.content ?? null,
          tenantEvidence,
          matches: (tenantEvidence.sources ?? []).map((source) => ({
            id: source.recordId ?? source.id, content: source.content,
            answer: source.content, recordType: source.recordType,
          })),
        };
        const engineDecision = tenantEvidence.decision;
        assert.equal(isKnowledgeEngineDecision(engineDecision), true,
          `${call.id} turn ${index + 1}: retrieval returned an invalid engine decision`);
        const token = memory.beginTurn(`${call.id}:${index + 1}`);
        memory.append({ role: 'user', content: utterance }, { turnToken: token });
        let finalDecision;
        let finalText;
        let selectedEvidenceIds = [];
        let selectedRecordIds = [];
        let responseId = null;
        let llmMs = 0;
        let envelope = null;
        let unifiedApplied = false;
        let groundedStateUpdate = null;
        if (engineDecision.type === knowledgeEngineDecisionTypes.CLARIFY) {
          if (turn.allowTargetedClarification === true) {
            finalDecision = 'clarify';
            finalText = engineDecision.clarification?.prompt;
            assert.ok(String(finalText ?? '').trim(),
              `${call.id} turn ${index + 1}: targeted clarification has no prompt`);
          } else {
            finalDecision = 'safe_failure';
            finalText = safeResponse;
          }
          if (turn.allowSafeResponse !== true && turn.allowTargetedClarification !== true) {
            throw new Error(`${call.id} turn ${index + 1}: unexpectedly routed to safe failure (${engineDecision.reason})`);
          }
        } else if (engineDecision.type === knowledgeEngineDecisionTypes.RESPONSE
          && engineDecision.mode === knowledgeEngineResponseModes.DETERMINISTIC
          && engineDecision.response?.text) {
          envelope = buildGroundingEnvelope(
            knowledge, { includePublishedMap: false, maximumSources: 5 },
          );
          const directEnvelopeSource = envelope.sources.find((source) => (
            source.recordId === engineDecision.response.recordId
          )) ?? null;
          assert.ok(directEnvelopeSource,
            `${call.id} turn ${index + 1}: directly matched response is missing from the grounding envelope`);
          finalDecision = 'answer';
          finalText = engineDecision.response.text;
          responseId = directEnvelopeSource.id;
          selectedEvidenceIds = responseId ? [responseId] : [];
          selectedRecordIds = directEnvelopeSource.recordId
            ? [directEnvelopeSource.recordId] : [];
          memory.setPendingQuestion(null);
        } else {
          envelope = buildGroundingEnvelope(
            knowledge, { includePublishedMap: false, maximumSources: 5 },
          );
          assert.ok(envelope.sources.length > 0 && envelope.sources.length <= 5,
            `${call.id} turn ${index + 1}: expected one to five selected records`);
          const llmStartedAt = performance.now();
          const decisionInput = {
            callId, query: utterance,
            history: memory.promptMessages?.() ?? snapshot.recentTurns,
            knowledge,
            context: {
              groundedResponseMode: true, compactGrounding: true,
              latestCallerUtterance: utterance, latestRequestPriority: 'primary',
              liveCallMemory: compactIsolatedCallMemory(memory.snapshot(), 1_600),
              configuredInformationFields: memory.fieldSchemas(), configuredToolSchemas: tools,
            },
            usageDirection: direction,
          };
          let rawDecision = await collectDecision(profile, decisionInput, providerRegistry);
          let unified = applyUnifiedGroundedTurn({
            rawDecision, groundingEnvelope: envelope, memory, turnToken: token,
            fieldSchemas: memory.fieldSchemas(), tools, evidence: hydrated, evidenceScope: scope,
            safetyPolicies: profile.agent.settings?.safetyPolicies ?? [],
            finalizedUtterance: utterance,
          });
          if (!unified.valid && isRepairableGroundedDecisionReason(unified.reason)) {
            rawDecision = await collectDecision(profile, {
              ...decisionInput,
              context: {
                ...decisionInput.context,
                decisionRepair: {
                  reason: unified.reason,
                  identifiers: unified.identifiers ?? [],
                  numbers: unified.numbers ?? [],
                },
              },
            }, providerRegistry);
            unified = applyUnifiedGroundedTurn({
              rawDecision, groundingEnvelope: envelope, memory, turnToken: token,
              fieldSchemas: memory.fieldSchemas(), tools, evidence: hydrated, evidenceScope: scope,
              safetyPolicies: profile.agent.settings?.safetyPolicies ?? [],
              finalizedUtterance: utterance,
            });
          }
          llmMs = performance.now() - llmStartedAt;
          assert.equal(unified.valid, true, `${call.id} turn ${index + 1}: invalid final decision ${JSON.stringify({
            reason: unified.reason ?? 'unknown',
            identifiers: unified.identifiers ?? [],
            numbers: unified.numbers ?? [],
            rejectedSentence: unified.rejectedSentence ?? null,
            evidenceIds: unified.evidenceIds ?? [],
          })}`);
          finalDecision = unified.decision;
          finalText = unified.answer;
          unifiedApplied = true;
          groundedStateUpdate = unified.stateUpdate ?? null;
          selectedEvidenceIds = [...unified.evidenceIds];
          responseId = unified.responseId ?? null;
          selectedRecordIds = selectedEvidenceIds.map((id) => (
            envelope.sources.find((source) => source.id === id)?.recordId
          )).filter(Boolean);
          const allowedIds = new Set(envelope.sources.map((source) => source.id));
          assert.ok(selectedEvidenceIds.every((id) => allowedIds.has(id)),
            `${call.id} turn ${index + 1}: decision selected evidence outside top records`);
          assert.ok(!unified.toolRequest || tools.some((tool) => tool.name === unified.toolRequest.name),
            `${call.id} turn ${index + 1}: unauthorized tool request`);
          if (!turn.expectedToolName) {
            assert.equal(unified.toolRequest, null,
              `${call.id} turn ${index + 1}: an information-only turn requested a tool`);
          } else {
            assert.equal(unified.toolRequest?.name, turn.expectedToolName,
              `${call.id} turn ${index + 1}: expected tool was not selected`);
          }
          if (turn.expectedActiveToolName) {
            assert.equal(unified.state?.activeToolRequest?.name, turn.expectedActiveToolName,
              `${call.id} turn ${index + 1}: expected Workflow was not activated`);
            assert.equal(unified.toolRequest, null,
              `${call.id} turn ${index + 1}: Workflow must collect and confirm before execution`);
          }
          if (turn.expectedNextField) {
            assert.equal(unified.nextQuestion?.key, turn.expectedNextField,
              `${call.id} turn ${index + 1}: did not ask the first missing UI field`);
          }
          if (turn.expectFirstMissingConfiguredField === true) {
            const firstMissing = unified.state?.activeToolRequest
              ?.workflowState?.missingFields?.[0];
            assert.ok(firstMissing,
              `${call.id} turn ${index + 1}: active Workflow has no missing configured field`);
            assert.equal(unified.nextQuestion?.key, firstMissing,
              `${call.id} turn ${index + 1}: did not ask only the first missing UI field`);
          }
          if (turn.allowInformationCollection !== true) {
            assert.deepEqual(unified.stateUpdate?.collectedInformation ?? {}, {},
              `${call.id} turn ${index + 1}: personal/configured fields were collected without authorization`);
          }
        }
        assert.ok(String(finalText ?? '').trim(), `${call.id} turn ${index + 1}: empty TTS text`);
        if (turn.forbidConfiguredTechnicalFailure === true) {
          assert.notEqual(normalized(finalText), normalized(technicalResponse),
            `${call.id} turn ${index + 1}: false Technical Failure Message was spoken`);
        }
        assert.doesNotMatch(String(finalText), /(?:"evidenceIds"|"stateUpdate"|"toolRequest")/u,
          `${call.id} turn ${index + 1}: internal JSON reached TTS`);
        const retrievedRecordIds = hydrated.map((source) => source.recordId).filter(Boolean);
        if (Array.isArray(turn.expectedAnyRecordIds) && turn.expectedAnyRecordIds.length) {
          assert.ok(turn.expectedAnyRecordIds.some((id) => retrievedRecordIds.includes(id)),
            `${call.id} turn ${index + 1}: expected record ID was not retrieved`);
        }
        const expectation = verifyTurnExpectations({
          call, index, turn, tenantEvidence, hydrated, envelope,
          selectedRecordIds, responseId, finalText, finalDecision, safeResponse,
          memoryState: memory.snapshot(), memoryBefore: snapshot, groundedStateUpdate,
          recordAliases,
        });
        const tts = requireLiveTts
          ? await synthesizeLiveTts(profile, finalText, providerRegistry) : null;
        if (!unifiedApplied) {
          memory.append({ role: 'assistant', content: finalText }, { turnToken: token });
        }
        const finalMemory = memory.snapshot();
        assert.equal(finalMemory.recentTurns.at(-1)?.role, 'assistant',
          `${call.id} turn ${index + 1}: final assistant turn was not stored`);
        assert.equal(finalMemory.recentTurns.at(-1)?.content, finalText,
          `${call.id} turn ${index + 1}: memory does not contain final TTS text`);
        const adjacentDuplicate = finalMemory.recentTurns.some((entry, entryIndex, turns) => (
          entryIndex > 0 && entry.role === 'assistant' && turns[entryIndex - 1]?.role === 'assistant'
          && normalized(entry.content) === normalized(turns[entryIndex - 1]?.content)
        ));
        assert.equal(adjacentDuplicate, false,
          `${call.id} turn ${index + 1}: assistant response was duplicated in memory`);
        const totalMs = performance.now() - totalStartedAt;
        samples.push({
          callId: call.id, turn: index + 1, utterance,
          retrievalMs, llmMs, totalMs,
          retrievalStages: tenantEvidence.retrieval ?? {},
        });
        results.push({
          callId: call.id, turn: index + 1, utterance,
          publicationRevisions, retrievedRecordIds, selectedEvidenceIds,
          selectedRecordIds, responseId, finalDecision, memory: finalMemory,
          retrievalTrace,
          routing: engineDecision, expectation,
          language: replayLanguage,
          positiveSemanticRecordIds: positiveSemanticCandidates.map(sourceRecordId),
          directCanonicalMemory,
          toolSafe: true, ttsText: finalText, latencyMs: { retrievalMs, llmMs, totalMs },
          tts,
        });
      }
    } finally {
      memory.close();
    }
   }
  }
  assert.ok(qdrantCandidates > 0, 'No Qdrant semantic candidates were observed in the live replay');
  for (const language of replay.requiredLanguages ?? ['ta', 'tanglish', 'en']) {
    assert.ok(replayLanguages.has(language), `Live replay is missing unseen ${language} coverage`);
  }
  const latency = Object.fromEntries(['retrievalMs', 'llmMs', 'totalMs'].map((field) => [field, {
    p50: percentile(samples.map((sample) => sample[field]), 0.50),
    p90: percentile(samples.map((sample) => sample[field]), 0.90),
    p95: percentile(samples.map((sample) => sample[field]), 0.95),
  }]));
  const configuredThresholds = replay.latencyThresholdsMs ?? {};
  const thresholds = {
    retrievalP95: Number(argument('retrieval-p95-ms', process.env.PRODUCTION_ACCEPTANCE_RETRIEVAL_P95_MS
      ?? configuredThresholds.retrievalP95 ?? 150)),
    llmP95: Number(argument('llm-p95-ms', process.env.PRODUCTION_ACCEPTANCE_LLM_P95_MS
      ?? configuredThresholds.llmP95 ?? 3_000)),
    totalP95: Number(argument('total-p95-ms', process.env.PRODUCTION_ACCEPTANCE_TOTAL_P95_MS
      ?? configuredThresholds.totalP95 ?? 3_500)),
  };
  const slowestRetrieval = [...samples]
    .sort((left, right) => right.retrievalMs - left.retrievalMs)
    .slice(0, 3).map((sample) => ({
      callId: sample.callId, turn: sample.turn, utterance: sample.utterance,
      retrievalMs: Math.round(sample.retrievalMs * 100) / 100,
      stages: sample.retrievalStages,
    }));
  assert.ok(latency.retrievalMs.p95 <= thresholds.retrievalP95,
    `Production retrieval p95 ${latency.retrievalMs.p95.toFixed(2)}ms exceeds ${thresholds.retrievalP95}ms ${JSON.stringify({ slowestRetrieval })}`);
  assert.ok(latency.llmMs.p95 <= thresholds.llmP95,
    `Production LLM p95 ${latency.llmMs.p95.toFixed(2)}ms exceeds ${thresholds.llmP95}ms`);
  assert.ok(latency.totalMs.p95 <= thresholds.totalP95,
    `Production total p95 ${latency.totalMs.p95.toFixed(2)}ms exceeds ${thresholds.totalP95}ms`);
  const report = {
    version: 3, mode: 'live_candidate_revision_postgresql_qdrant', passed: true,
    generatedAt: new Date().toISOString(), agentId: agent.id,
    replayVersion: replay.version ?? 1,
    replayFile: replayPath,
    sourceCallIds: replay.calls.map((call) => call.sourceCallId).filter(Boolean),
    callCount: replay.calls.length * repeats, turnCount: results.length, repeats,
    qdrantCandidates, latency, thresholds,
    candidateRevisions, candidateRevisionFingerprint,
    extractionArtifacts,
    release,
    replayLanguages: [...replayLanguages].sort(),
    verification: {
      allHydratedEvidenceScopeValidated: true,
      retrievedIdsRecorded: true,
      selectedEvidenceIdsValidated: true,
      candidateRevisionPinned: true,
      postgresRevisionValidated: true,
      qdrantRevisionValidated: true,
      perTurnSemanticScoresValidated: true,
      evidenceTypesValidated: true,
      memoryValidated: true,
      toolSafetyValidated: true,
      overviewResponsesValidated: results.filter((result) => (
        result.expectation.exactPublishedResponse
      )).length,
      followUpEntitiesValidated: results.filter((result) => (
        result.expectation.expectedCatalogRecordIds.length > 0
      )).length,
      catalogDetailsValidated: true,
      fallbackValidated: true,
      finalTtsTextValidated: results.length,
      liveTtsAudioValidated: requireLiveTts ? results.length : 0,
      extractionArtifactsValidated: extractionArtifacts.length,
      deployedReleaseIdentityValidated: requireReleaseIdentity,
    },
    results,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    passed: true, mode: report.mode, callCount: report.callCount,
    turnCount: report.turnCount, qdrantCandidates, latency, thresholds,
    verification: report.verification, reportPath,
  }));
} finally {
  await closeDatabase();
}
