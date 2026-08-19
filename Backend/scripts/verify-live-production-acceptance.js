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
  compactGenericConversationState, openGenericConversationState,
} from '../src/voice/interaction/generic-conversation-state.js';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';
import { applyUnifiedGroundedTurn } from '../src/voice/interaction/unified-grounded-turn.js';
import { evidenceBelongsToRuntime } from '../src/voice/interaction/grounded-decision-security.js';
import { configuredSafeFailureResponse } from '../src/voice/realtime-conversation-orchestrator.js';

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
  responseId, finalText, safeResponse, memoryState,
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
    assert.ok(selectedRecordIds.some((id) => catalogRecordIds.has(id)),
      `${label}: grounded decision did not cite the expected Catalog evidence`);
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
    assert.ok((memoryState.knownEntities ?? []).some((entity) => (
      normalized(entity?.key) === normalized(turn.expectedMemoryEntityKey)
    )), `${label}: selected follow-up entity was not preserved in memory`);
  }
  if ((turn.expectedResponseNodeKeys?.length ?? 0) > 0) {
    const expectedKeys = new Set(turn.expectedResponseNodeKeys.map(normalized));
    const direct = tenantEvidence.directResponse;
    assert.ok(direct && expectedKeys.has(normalized(direct.authoritativeData?.nodeKey)),
      `${label}: expected caller-facing published response was not selected by retrieval`);
    if (turn.requireExactPublishedResponse === true) {
      assert.ok(responseId, `${label}: exact published responseId was not selected`);
      const exactSource = (envelope?.sources ?? []).find((source) => source.id === responseId);
      assert.equal(exactSource?.recordId, direct.recordId,
        `${label}: responseId does not identify the matched published response`);
      assert.equal(finalText, direct.content,
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

async function collectDecision(profile, input) {
  const session = await createSelectedLlmStream(profile, input);
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
const replayPath = resolve(argument(
  'replay-file', process.env.PRODUCTION_ACCEPTANCE_REPLAY_FILE
    ?? 'fixtures/failed-call-2026-08-19-production.json',
));
const reportPath = resolve(argument(
  'report-file', process.env.PRODUCTION_ACCEPTANCE_REPORT
    ?? 'artifacts/production-acceptance-report.json',
));
const replay = JSON.parse(await readFile(replayPath, 'utf8'));
assert.ok(Array.isArray(replay.calls) && replay.calls.length > 0, 'At least one failed call replay is required');

const agent = await resolveAgent(agentId);
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
let semanticCandidates = 0;
const safeResponse = configuredSafeFailureResponse(profile);

try {
  for (const call of replay.calls) {
    assert.ok(Array.isArray(call.turns) && call.turns.length > 0, `${call.id}: turns are required`);
    const callId = `production-acceptance:${call.id}`;
    const memory = openGenericConversationState({
      tenantId: agent.tenant_id, workspaceId: agent.workspace_id,
      agentId: agent.id, callId,
    }, profile.agent.settings, Date.now(), { language: profile.agent.language });
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
        const totalStartedAt = performance.now();
        const retrievalStartedAt = performance.now();
        const snapshot = memory.snapshot();
        const tenantEvidence = await retrieveTenantEvidence(auth, {
          agentId: agent.id,
          query: utterance,
          latestCallerUtterance: utterance,
          latestRequestPriority: 'primary',
          usageDirection: direction,
          language: snapshot.language,
          knownEntities: snapshot.knownEntities,
          pendingQuestion: snapshot.pendingQuestion?.text ?? null,
          collectedInformation: snapshot.collectedInformation,
          topK: 5,
        });
        const retrievalMs = performance.now() - retrievalStartedAt;
        const publicationRevisions = tenantEvidence.publicationRevisions ?? [];
        assert.ok(publicationRevisions.length > 0, `${call.id} turn ${index + 1}: no active publication revision`);
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
        const scope = {
          tenantId: agent.tenant_id, agentId: agent.id,
          publicationRevisions, requireHydratedEvidence: true,
        };
        for (const source of hydrated) {
          assert.equal(evidenceBelongsToRuntime(source, scope), true,
            `${call.id} turn ${index + 1}: foreign, stale or unhydrated evidence ${source.recordId}`);
        }
        semanticCandidates += Number(tenantEvidence.retrieval?.semanticCandidates ?? 0);
        const knowledge = {
          route: 'llm_first', found: tenantEvidence.found === true,
          content: tenantEvidence.sources?.[0]?.content ?? null,
          tenantEvidence,
          matches: (tenantEvidence.sources ?? []).map((source) => ({
            id: source.recordId ?? source.id, content: source.content,
            answer: source.content, recordType: source.recordType,
          })),
        };
        const responseRouting = tenantEvidence.responseRouting ?? {
          outcome: tenantEvidence.found ? 'grounded_llm' : 'clarify', reason: 'missing_evidence',
        };
        const token = memory.beginTurn(`${call.id}:${index + 1}`);
        memory.append({ role: 'user', content: utterance }, { turnToken: token });
        let finalDecision;
        let finalText;
        let selectedEvidenceIds = [];
        let selectedRecordIds = [];
        let responseId = null;
        let llmMs = 0;
        let envelope = null;
        if (responseRouting.outcome === 'clarify') {
          finalDecision = 'safe_failure';
          finalText = safeResponse;
          if (turn.allowSafeResponse !== true) {
            throw new Error(`${call.id} turn ${index + 1}: unexpectedly routed to safe failure (${responseRouting.reason})`);
          }
        } else {
          envelope = buildGroundingEnvelope(
            knowledge, { includePublishedMap: false, maximumSources: 5 },
          );
          assert.ok(envelope.sources.length > 0 && envelope.sources.length <= 5,
            `${call.id} turn ${index + 1}: expected one to five selected records`);
          const llmStartedAt = performance.now();
          const rawDecision = await collectDecision(profile, {
            callId, query: utterance,
            history: memory.promptMessages?.() ?? snapshot.recentTurns,
            knowledge,
            context: {
              groundedResponseMode: true, compactGrounding: true,
              latestCallerUtterance: utterance, latestRequestPriority: 'primary',
              liveCallMemory: compactGenericConversationState(memory.snapshot(), 1_600),
              configuredInformationFields: memory.fieldSchemas(), configuredToolSchemas: tools,
            },
            usageDirection: direction,
          });
          llmMs = performance.now() - llmStartedAt;
          const unified = applyUnifiedGroundedTurn({
            rawDecision, groundingEnvelope: envelope, memory, turnToken: token,
            fieldSchemas: memory.fieldSchemas(), tools, evidence: hydrated, evidenceScope: scope,
            safetyPolicies: profile.agent.settings?.safetyPolicies ?? [],
            finalizedUtterance: utterance,
          });
          assert.equal(unified.valid, true,
            `${call.id} turn ${index + 1}: invalid final decision (${unified.reason ?? 'unknown'})`);
          finalDecision = unified.decision;
          finalText = unified.answer;
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
        }
        assert.ok(String(finalText ?? '').trim(), `${call.id} turn ${index + 1}: empty TTS text`);
        const retrievedRecordIds = hydrated.map((source) => source.recordId).filter(Boolean);
        if (Array.isArray(turn.expectedAnyRecordIds) && turn.expectedAnyRecordIds.length) {
          assert.ok(turn.expectedAnyRecordIds.some((id) => retrievedRecordIds.includes(id)),
            `${call.id} turn ${index + 1}: expected record ID was not retrieved`);
        }
        const expectation = verifyTurnExpectations({
          call, index, turn, tenantEvidence, hydrated, envelope,
          selectedRecordIds, responseId, finalText, safeResponse,
          memoryState: memory.snapshot(),
        });
        memory.append({ role: 'assistant', content: finalText }, { turnToken: token });
        const totalMs = performance.now() - totalStartedAt;
        samples.push({ retrievalMs, llmMs, totalMs });
        results.push({
          callId: call.id, turn: index + 1, utterance,
          publicationRevisions, retrievedRecordIds, selectedEvidenceIds,
          selectedRecordIds, responseId, finalDecision, memory: memory.snapshot(),
          retrievalTrace,
          routing: responseRouting, expectation,
          toolSafe: true, ttsText: finalText, latencyMs: { retrievalMs, llmMs, totalMs },
        });
      }
    } finally {
      memory.close();
    }
  }
  assert.ok(semanticCandidates > 0, 'No Qdrant semantic candidates were observed in the live replay');
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
  assert.ok(latency.retrievalMs.p95 <= thresholds.retrievalP95,
    `Production retrieval p95 ${latency.retrievalMs.p95.toFixed(2)}ms exceeds ${thresholds.retrievalP95}ms`);
  assert.ok(latency.llmMs.p95 <= thresholds.llmP95,
    `Production LLM p95 ${latency.llmMs.p95.toFixed(2)}ms exceeds ${thresholds.llmP95}ms`);
  assert.ok(latency.totalMs.p95 <= thresholds.totalP95,
    `Production total p95 ${latency.totalMs.p95.toFixed(2)}ms exceeds ${thresholds.totalP95}ms`);
  const report = {
    version: 2, mode: 'live_postgresql_qdrant', passed: true,
    generatedAt: new Date().toISOString(), agentId: agent.id,
    replayVersion: replay.version ?? 1,
    replayFile: replayPath,
    sourceCallIds: replay.calls.map((call) => call.sourceCallId).filter(Boolean),
    callCount: replay.calls.length, turnCount: results.length,
    semanticCandidates, latency, thresholds,
    verification: {
      allHydratedEvidenceScopeValidated: true,
      retrievedIdsRecorded: true,
      selectedEvidenceIdsValidated: true,
      overviewResponsesValidated: results.filter((result) => (
        result.expectation.exactPublishedResponse
      )).length,
      followUpEntitiesValidated: results.filter((result) => (
        result.expectation.expectedCatalogRecordIds.length > 0
      )).length,
      catalogDetailsValidated: true,
      fallbackValidated: true,
      finalTtsTextValidated: results.length,
    },
    results,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    passed: true, mode: report.mode, callCount: report.callCount,
    turnCount: report.turnCount, semanticCandidates, latency, thresholds,
    verification: report.verification, reportPath,
  }));
} finally {
  await closeDatabase();
}
