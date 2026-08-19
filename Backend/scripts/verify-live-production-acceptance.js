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
    ?? 'fixtures/production-failed-transcripts.json',
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

try {
  for (const call of replay.calls) {
    assert.ok(Array.isArray(call.turns) && call.turns.length > 0, `${call.id}: turns are required`);
    const callId = `production-acceptance:${call.id}`;
    const memory = openGenericConversationState({
      tenantId: agent.tenant_id, workspaceId: agent.workspace_id,
      agentId: agent.id, callId,
    }, profile.agent.settings, Date.now(), { language: profile.agent.language });
    try {
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
        let responseId = null;
        let llmMs = 0;
        if (responseRouting.outcome === 'clarify') {
          finalDecision = 'safe_failure';
          finalText = configuredSafeFailureResponse(profile);
          if (turn.allowSafeResponse !== true) {
            throw new Error(`${call.id} turn ${index + 1}: unexpectedly routed to safe failure (${responseRouting.reason})`);
          }
        } else {
          const envelope = buildGroundingEnvelope(
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
        const totalMs = performance.now() - totalStartedAt;
        samples.push({ retrievalMs, llmMs, totalMs });
        results.push({
          callId: call.id, turn: index + 1, utterance,
          publicationRevisions, retrievedRecordIds, selectedEvidenceIds,
          responseId, finalDecision, memory: memory.snapshot(),
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
  const report = {
    version: 1, mode: 'live_postgresql_qdrant', passed: true,
    generatedAt: new Date().toISOString(), agentId: agent.id,
    callCount: replay.calls.length, turnCount: results.length,
    semanticCandidates, latency, results,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    passed: true, mode: report.mode, callCount: report.callCount,
    turnCount: report.turnCount, semanticCandidates, latency, reportPath,
  }));
} finally {
  await closeDatabase();
}
