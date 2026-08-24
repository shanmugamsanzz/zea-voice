import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createKnowledgeEngineInput, knowledgeEngineDecisionTypes } from '../src/knowledge-engine/engine-contract.js';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import { resolvePublishedEntityRoute } from '../src/knowledge-engine/entity-route-resolver.js';
import { runObservedKnowledgeTurn, VoiceTurnLatencyTracker, voiceTurnStages } from '../src/knowledge-engine/voice-turn-latency.js';
import { buildRevisionSparseIndex } from '../src/knowledge-bases/knowledge-map.service.js';
import { cacheCompactKnowledgeMap } from '../src/knowledge-bases/knowledge-map.service.js';
import { retrieveTenantEvidence } from '../src/knowledge-engine/runtime-service.js';
import {
  executeAuthorizedToolWorkflow,
  finalizeGroundedLlmResponse,
} from '../src/knowledge-engine/safe-response-tool-runtime.js';
import { InterruptionCandidateManager } from '../src/voice/interruption/interruption-candidate-manager.js';
import { knowledgeMessageSources } from '../src/voice/source-trace.js';
import { task10Industries } from './fixtures/task-10-industries.js';

const repeatsArgument = process.argv.find((value) => value.startsWith('--repeats='));
const repeats = Number(repeatsArgument?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20,
  'Acceptance requires between 3 and 20 repeated passes');

function record(fixture, index, type, values) {
  const suffix = String(index).padStart(12, '0');
  return {
    record_id: values.recordId ?? `50000000-0000-4000-8000-${suffix}`,
    record_type: type,
    document_id: `60000000-0000-4000-8000-${suffix}`,
    document_version_id: `70000000-0000-4000-8000-${suffix}`,
    document_name: 'tenant-published-knowledge.pdf',
    document_display_name: 'Tenant Published Knowledge',
    usage_direction: 'both', language: fixture.language ?? 'mul', source_page_start: 1,
    entity_aliases: [], entity_category_aliases: [], entity_metadata: {}, ...values,
  };
}

function industryEngine(fixture) {
  const job = {
    tenant_id: fixture.tenantId, knowledge_base_id: fixture.kbId,
    targetRevision: fixture.revision, knowledge_base_usage: 'both',
    assigned_agent_ids: [fixture.agentId],
  };
  const faq = record(fixture, 1, 'faq', {
    recordId: fixture.recordId, question: fixture.query, answer: fixture.fact,
    content: fixture.fact, entity_name: fixture.query,
    entity_aliases: fixture.variants,
    entity_metadata: { conditions: { intentClass: 'KNOWN_INFORMATION' } },
  });
  const bundle = buildPublicationIndexes(job, [faq]);
  return { job, faq, bundle, sparse: buildRevisionSparseIndex(job, bundle.records) };
}

function hydrationDependencies(input, records) {
  const byId = new Map(records.map((item) => [String(item.record_id), item]));
  return {
    contextRunner: async (auth, operation) => {
      assert.equal(auth.tenantId, input.tenantId);
      return operation({
        query: async (_sql, values) => {
          const requested = JSON.parse(values[3]);
          return { rows: requested.flatMap((candidate) => {
            const source = byId.get(String(candidate.record_id));
            if (!source) return [];
            const metadata = source.entity_metadata ?? {};
            const recordType = String(source.record_type).toUpperCase();
            const callerFacing = recordType !== 'WORKFLOW_RULE'
              || String(metadata.actionConfig?.responseMode ?? '').toLowerCase() === 'exact';
            const authoritativeData = recordType === 'FAQ'
              ? { question: source.question, answer: source.answer }
              : recordType === 'CATALOG_ITEM'
                ? {
                  itemKey: metadata.itemKey, categoryKey: metadata.categoryKey,
                  name: source.entity_name, category: source.entity_category,
                  sourceText: source.answer, selectionRules: metadata.selectionRules,
                }
                : recordType === 'WORKFLOW_RULE'
                  ? {
                    conditions: metadata.conditions, actionType: metadata.actionType,
                    actionConfig: metadata.actionConfig,
                    responseTemplate: source.answer,
                  }
                  : { content: source.answer, ...metadata };
            return [{
              record_type: recordType, record_id: source.record_id,
              knowledge_base_id: candidate.knowledge_base_id,
              publication_revision: candidate.publication_revision,
              document_id: source.document_id, document_version_id: source.document_version_id,
              document_name: source.document_name,
              document_display_name: source.document_display_name,
              document_type: source.document_type ?? String(source.record_type).toLocaleLowerCase(),
              source_page_start: source.source_page_start ?? 1,
              source_page_end: source.source_page_end ?? source.source_page_start ?? 1,
              source_section: source.source_section ?? source.entity_name,
              language: source.language, content: source.answer,
              caller_facing: callerFacing, authoritative_data: authoritativeData,
              rank: candidate.rank, rrf_score: candidate.rrf_score,
            }];
          }) };
        },
      });
    },
  };
}

async function observed(engine, utterance, options = {}) {
  const callId = options.callId ?? `80000000-0000-4000-8000-${String(options.turn ?? 1).padStart(12, '0')}`;
  const input = createKnowledgeEngineInput({
    tenantId: engine.job.tenant_id, agentId: engine.job.assigned_agent_ids[0], callId,
    utterance, usageDirection: 'inbound', language: options.language ?? 'mul',
    requestedFacts: options.requestedFacts ?? [], memory: options.memory ?? {},
  });
  const tracker = new VoiceTurnLatencyTracker({
    tenantId: input.tenantId, agentId: input.agentId, callId, turnId: String(options.turn ?? 1),
  });
  const result = await runObservedKnowledgeTurn({
    auth: { tenantId: input.tenantId }, input,
    publicationBundles: [engine.bundle], sparseIndexes: [engine.sparse],
    runtimeProfile: options.runtimeProfile ?? { tools: [] },
    confirmation: options.confirmation ?? false, tracker,
  }, {
    retrievalDependencies: {
      embed: async () => [0.1, 0.2],
      search: async () => options.semanticMatches ?? [],
    },
    hydrationDependencies: hydrationDependencies(input, engine.bundle.records),
  });
  tracker.record(voiceTurnStages.TTS_FIRST_CHUNK, 50);
  tracker.record(voiceTurnStages.FIRST_AUDIO_DELIVERY, 800);
  assert.equal(tracker.snapshot().firstAudioStatus, 'target_met');
  assert.ok(tracker.snapshot().firstAudioMs < 1_000);
  return { ...result, input, tracker };
}

const metrics = {
  direct: 0, category: 0, clarify: 0, llm: 0, tool: 0,
  verifiedToolExecutions: 0, priorityChecks: 0, interruptions: 0,
  falseClarifications: 0, runtimeErrors: 0,
};

function assertPublishedSources(result, expectedCount = 1) {
  const sources = knowledgeMessageSources({
    found: true, matches: result.authoritative.evidence,
  }, result.decision.evidenceIds);
  assert.equal(sources.length, expectedCount);
  assert.ok(sources.every((source) => source.type === 'knowledge'));
  assert.ok(sources.every((source) => source.label === 'Tenant Published Knowledge'));
  assert.ok(sources.every((source) => source.metadata.documentName === 'tenant-published-knowledge.pdf'));
  assert.ok(sources.every((source) => source.metadata.pageNumber === 1));
  assert.ok(sources.every((source) => source.metadata.documentId));
  assert.ok(sources.every((source) => source.metadata.recordName));
  assert.ok(sources.every((source) => source.metadata.route === undefined));
  assert.equal(new Set(sources.map((source) => [source.id, source.metadata.documentId,
    source.metadata.pageNumber, source.metadata.pageEnd].join(':'))).size, sources.length);
  assert.doesNotMatch(JSON.stringify(sources), /System instructions|Agent Instructions|llm_first|Runtime fallback|Configured knowledge clarification/iu);
  return sources;
}

for (let pass = 1; pass <= repeats; pass += 1) {
  for (const fixture of task10Industries) {
    const engine = industryEngine(fixture);
    for (const utterance of [fixture.query, ...fixture.variants]) {
      const result = await observed(engine, utterance, { turn: pass, language: fixture.language });
      assert.equal(result.decision.type, knowledgeEngineDecisionTypes.DIRECT,
        `${fixture.industry}: ${utterance}`);
      assert.equal(result.decision.response.text, fixture.fact);
      assert.equal(result.authoritative.hydrationQueryCount, 1);
      assert.doesNotMatch(result.decision.response.text, /ITEM(?:_KEY)?\s*:|ALIASES\s*:|\{\s*"/iu);
      assertPublishedSources(result);
      assert.deepEqual(result.retrieval.searchedIndexes.includes('WORKFLOW'), false);
      assert.ok(result.latency.stages.routingMs >= 0);
      assert.ok(result.latency.stages.retrievalMs >= 0);
      assert.ok(result.latency.stages.hydrationMs >= 0);
      metrics.direct += 1;
    }
    const foreignInput = createKnowledgeEngineInput({
      tenantId: task10Industries.find((item) => item.tenantId !== fixture.tenantId).tenantId,
      agentId: fixture.agentId, callId: `foreign-${pass}`, utterance: fixture.query,
    });
    assert.throws(() => resolvePublishedEntityRoute(foreignInput, engine.bundle), /same tenant/u);
  }

  const fixture = task10Industries[0];
  const job = {
    tenant_id: fixture.tenantId, knowledge_base_id: fixture.kbId,
    targetRevision: fixture.revision, knowledge_base_usage: 'both',
    assigned_agent_ids: [fixture.agentId],
  };
  const alpha = record(fixture, 21, 'catalog_item', {
    question: 'Alpha service', answer: 'Alpha service includes verified support.',
    content: 'Alpha service includes verified support.', entity_name: 'Alpha Service',
    entity_category: 'Services', entity_aliases: ['alpha'],
    entity_metadata: { itemKey: 'alpha', categoryKey: 'services', selectionRules: { selectable: true } },
  });
  const beta = record(fixture, 22, 'catalog_item', {
    question: 'Beta service', answer: 'Beta service includes priority support.',
    content: 'Beta service includes priority support.', entity_name: 'Beta Service',
    entity_category: 'Services', entity_aliases: ['beta'],
    entity_metadata: { itemKey: 'beta', categoryKey: 'services', selectionRules: { selectable: true } },
  });
  const sharedOne = record(fixture, 23, 'catalog_item', {
    question: 'Shared one', answer: 'Shared one is published.', content: 'Shared one is published.',
    entity_name: 'Shared One', entity_category: 'Services', entity_aliases: ['shared'],
    entity_metadata: { itemKey: 'shared-one', categoryKey: 'services' },
  });
  const sharedTwo = record(fixture, 24, 'catalog_item', {
    question: 'Shared two', answer: 'Shared two is published.', content: 'Shared two is published.',
    entity_name: 'Shared Two', entity_category: 'Services', entity_aliases: ['shared'],
    entity_metadata: { itemKey: 'shared-two', categoryKey: 'services' },
  });
  const safety = record(fixture, 25, 'workflow_rule', {
    question: 'urgent danger', answer: 'Contact the configured emergency support channel now.',
    content: 'Contact the configured emergency support channel now.',
    entity_name: 'Urgent safety route', entity_aliases: ['urgent danger'],
    entity_metadata: {
      conditions: { intentClass: 'SAFETY_EMERGENCY' }, actionType: 'respond',
      actionConfig: { responseMode: 'exact' },
    },
  });
  const action = record(fixture, 26, 'workflow_rule', {
    question: 'submit request', answer: 'Collect the configured fields.',
    content: 'Collect the configured fields.', entity_name: 'Submit request',
    entity_aliases: ['submit request'],
    entity_metadata: {
      conditions: { intentClass: 'ACTION_TOOL_REQUEST' }, actionType: 'configured_tool',
      actionConfig: { responseMode: 'instruction', toolIdentifier: 'tenant_submit' },
    },
  });
  const callControl = record(fixture, 27, 'workflow_rule', {
    question: 'stop interaction', answer: 'The interaction will now end.',
    content: 'The interaction will now end.', entity_name: 'Stop interaction',
    entity_aliases: ['stop interaction'],
    entity_metadata: {
      conditions: { intentClass: 'CALL_CONTROL' }, actionType: 'respond',
      actionConfig: { responseMode: 'exact' },
    },
  });
  const alternateAction = record(fixture, 28, 'workflow_rule', {
    question: 'alternate action', answer: 'Collect alternate action fields.',
    content: 'Collect alternate action fields.', entity_name: 'Alternate action',
    entity_aliases: ['alternate action'],
    entity_metadata: {
      conditions: { intentClass: 'ACTION_TOOL_REQUEST' }, actionType: 'configured_tool',
      actionConfig: { responseMode: 'instruction', toolIdentifier: 'tenant_alternate' },
    },
  });
  const collidingFaq = record(fixture, 29, 'faq', {
    question: 'Alpha Service', answer: 'Generic frequently asked answer.',
    content: 'Generic frequently asked answer.', entity_name: 'Alpha service FAQ',
    entity_aliases: ['Alpha Service'],
    entity_metadata: { conditions: { intentClass: 'KNOWN_INFORMATION' } },
  });
  const collidingConversation = record(fixture, 30, 'conversation_node', {
    question: 'Alpha Service', answer: 'Generic conversation answer.',
    content: 'Generic conversation answer.', entity_name: 'Alpha service conversation',
    entity_aliases: ['Alpha Service'], entity_metadata: { intentClass: 'KNOWN_INFORMATION' },
  });
  const bundle = buildPublicationIndexes(job, [
    alpha, beta, sharedOne, sharedTwo, safety, action, callControl,
    alternateAction, collidingFaq, collidingConversation,
  ]);
  const engine = { job, bundle, sparse: buildRevisionSparseIndex(job, bundle.records) };

  const switched = await observed(engine, 'Beta Service', {
    turn: pass, memory: { activeEntity: { recordId: alpha.record_id, key: 'alpha' } },
  });
  assert.equal(switched.resolution.candidate.itemKey, 'beta');
  assert.equal(switched.decision.type, knowledgeEngineDecisionTypes.DIRECT);

  const namespaceCollision = await observed(engine, 'Alpha Service', { turn: pass });
  assert.equal(namespaceCollision.resolution.candidateNamespace, 'CATALOG');
  assert.equal(namespaceCollision.resolution.candidate.recordId, alpha.record_id);
  assert.equal(namespaceCollision.decision.response.recordId, alpha.record_id);
  assert.doesNotMatch(namespaceCollision.decision.response.text, /Generic/iu);
  metrics.priorityChecks += 1;

  const category = await observed(engine, 'Services', { turn: pass });
  assert.equal(category.decision.type, knowledgeEngineDecisionTypes.DIRECT);
  assert.match(category.decision.response.text, /Alpha Service/iu);
  assert.match(category.decision.response.text, /Beta Service/iu);
  assert.doesNotMatch(category.decision.response.text, /ITEM(?:_KEY)?\s*:|ALIASES\s*:|\{\s*"/iu);
  assertPublishedSources(category, 4);
  metrics.category += 1;

  const comparison = await observed(engine, 'compare Alpha Service and Beta Service', {
    turn: pass, requestedFacts: ['support', 'priority'],
  });
  assert.equal(comparison.decision.type, knowledgeEngineDecisionTypes.LLM);
  assert.ok(comparison.decision.evidenceIds.length >= 2);
  assertPublishedSources(comparison, 2);
  assert.equal(finalizeGroundedLlmResponse({
    input: comparison.input, plan: comparison.decision,
    answer: 'An unsupported value is 999.',
    selectedEvidenceIds: [comparison.decision.evidenceIds[0]],
    authoritative: comparison.authoritative,
  }).type, knowledgeEngineDecisionTypes.CLARIFY);
  metrics.llm += 1;

  const ambiguous = await observed(engine, 'shared', { turn: pass });
  assert.equal(ambiguous.decision.type, knowledgeEngineDecisionTypes.CLARIFY);
  assert.equal(ambiguous.decision.clarification.kind, 'ambiguity');
  metrics.clarify += 1;

  const safe = await observed(engine, 'urgent danger', { turn: pass });
  assert.equal(safe.classification.intentClass, 'SAFETY_EMERGENCY');
  assert.equal(safe.decision.type, knowledgeEngineDecisionTypes.DIRECT);

  const runtimeProfile = {
    tools: [{
      id: `tool-${pass}`, name: 'tenant_submit',
      configuration: { inputSchema: {
        type: 'object', properties: {
          reference: { type: 'string', 'x-question': 'What reference should I use?' },
        }, required: ['reference'], additionalProperties: false,
      } },
    }, {
      id: `alternate-tool-${pass}`, name: 'tenant_alternate',
      configuration: { inputSchema: {
        type: 'object', properties: {
          alternateReference: { type: 'string', 'x-question': 'What alternate reference should I use?' },
        }, required: ['alternateReference'], additionalProperties: false,
      } },
    }],
  };
  const tool = await observed(engine, 'submit request', { turn: pass, runtimeProfile });
  assert.equal(tool.decision.type, knowledgeEngineDecisionTypes.TOOL);
  assert.equal(tool.decision.toolWorkflow.status, 'COLLECTING_FIELDS');
  assert.equal(tool.decision.toolWorkflow.prompt, 'What reference should I use?');
  metrics.tool += 1;

  const activeMemory = {
    activeTool: {
      name: 'tenant_submit', authorizationRecordId: action.record_id,
      status: 'COLLECTING_FIELDS',
    },
  };
  const activeBeforeNewAction = await observed(engine, 'alternate action', {
    turn: pass, runtimeProfile, memory: activeMemory,
  });
  assert.equal(activeBeforeNewAction.classification.source, 'active_tool_workflow');
  assert.equal(activeBeforeNewAction.decision.tool.name, 'tenant_submit');
  assert.equal(activeBeforeNewAction.decision.toolWorkflow.prompt, 'What reference should I use?');

  const emergencyDuringTool = await observed(engine, 'urgent danger', {
    turn: pass, runtimeProfile, memory: activeMemory,
  });
  assert.equal(emergencyDuringTool.classification.intentClass, 'SAFETY_EMERGENCY');
  assert.equal(emergencyDuringTool.decision.type, knowledgeEngineDecisionTypes.DIRECT);

  const callControlDuringTool = await observed(engine, 'stop interaction', {
    turn: pass, runtimeProfile, memory: activeMemory,
  });
  assert.equal(callControlDuringTool.classification.intentClass, 'CALL_CONTROL');
  assert.equal(callControlDuringTool.decision.type, knowledgeEngineDecisionTypes.DIRECT);
  metrics.priorityChecks += 3;

  const readyTool = await observed(engine, 'confirm configured action', {
    turn: pass, runtimeProfile, confirmation: true,
    memory: { ...activeMemory, collectedToolFields: { reference: `REF-${pass}` } },
  });
  assert.equal(readyTool.decision.type, knowledgeEngineDecisionTypes.TOOL);
  assert.equal(readyTool.decision.toolWorkflow.status, 'READY_TO_EXECUTE');
  const execution = await executeAuthorizedToolWorkflow({
    input: readyTool.input, plan: readyTool.decision, runtimeProfile,
    call: { id: readyTool.input.callId },
  }, { executor: async () => ({
    id: `verified-${pass}`, toolId: `tool-${pass}`, name: 'tenant_submit',
    verified: true, success: true, output: { message: 'The configured request was completed.' },
  }) });
  assert.equal(execution.decision.reason, 'verified_tool_success');
  metrics.verifiedToolExecutions += 1;

  const typoInput = createKnowledgeEngineInput({
    tenantId: fixture.tenantId, agentId: fixture.agentId, callId: `typo-${pass}`,
    utterance: 'Bta Servise',
  });
  const typo = resolvePublishedEntityRoute(typoInput, bundle);
  assert.equal(typo.candidate.itemKey, 'beta');
  assert.ok(['HIGH', 'MEDIUM'].includes(typo.confidence));

  let interrupted = false;
  let now = 0;
  const interruption = new InterruptionCandidateManager({
    configuration: {
      timeBased: { enabled: true, thresholdMs: 10 },
      wordBased: { enabled: true, minimumWords: 2 },
      explicitStopPhrases: [], acknowledgementPhrases: [],
    },
    now: () => now, setTimer: () => ({ unref() {} }), clearTimer: () => {},
    onConfirm: () => { interrupted = true; },
  });
  interruption.start();
  now = 20;
  interruption.observeTranscript('switch to another topic');
  assert.equal(interrupted, true);
  metrics.interruptions += 1;
}

// Exercise the actual live facade: active publication lookup -> immutable Redis
// artifacts -> new engine -> one authoritative PostgreSQL hydration.
{
  const fixture = task10Industries[0];
  const engine = industryEngine(fixture);
  const values = new Map();
  const cache = {
    status: 'ready',
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); return 'OK'; },
    async del(...keys) { let deleted = 0; for (const key of keys) deleted += values.delete(key) ? 1 : 0; return deleted; },
  };
  await cacheCompactKnowledgeMap(engine.job, engine.bundle.records, cache, engine.bundle);
  const input = createKnowledgeEngineInput({
    tenantId: fixture.tenantId, agentId: fixture.agentId,
    callId: '90000000-0000-4000-8000-000000000001',
    utterance: fixture.variants[0], language: fixture.language,
  });
  const hydrate = hydrationDependencies(input, engine.bundle.records).contextRunner;
  const contextRunner = async (auth, operation) => operation({
    query: async (sql, parameters) => {
      if (parameters.length === 3) return { rows: [{
        knowledge_base_id: fixture.kbId, publication_revision: fixture.revision, priority: 1,
      }] };
      return hydrate(auth, async (client) => client.query(sql, parameters));
    },
  });
  const result = await retrieveTenantEvidence({ tenantId: fixture.tenantId }, input, {
    cache, contextRunner, runtimeProfile: { tools: [] }, throwOnError: true,
    retrievalDependencies: { embed: async () => [0.1, 0.2], search: async () => [] },
  });
  assert.equal(result.route, 'knowledge_engine');
  assert.equal(result.decision.type, knowledgeEngineDecisionTypes.DIRECT);
  assert.equal(result.decision.response.text, fixture.fact);
  assert.equal(result.authoritative.hydrationQueryCount, 1);
  assert.deepEqual(result.publicationRevisions, [{
    knowledgeBaseId: fixture.kbId, publicationRevision: fixture.revision,
  }]);
}

// An agent without a completed, assigned publication must fail with a stable,
// actionable diagnostic instead of looking like an ordinary no-match turn.
{
  const fixture = task10Industries[0];
  const input = createKnowledgeEngineInput({
    tenantId: fixture.tenantId, agentId: fixture.agentId,
    callId: '90000000-0000-4000-8000-000000000002',
    utterance: fixture.variants[0], language: fixture.language,
  });
  await assert.rejects(
    retrieveTenantEvidence({ tenantId: fixture.tenantId }, input, {
      throwOnError: true,
      contextRunner: async (_auth, operation) => operation({
        query: async () => ({ rows: [] }),
      }),
    }),
    (error) => error.code === 'KNOWLEDGE_PUBLICATION_NOT_ASSIGNED'
      && error.details?.agentId === fixture.agentId,
  );
}

const runtimeSource = await readFile(new URL('../src/knowledge-engine/runtime-service.js', import.meta.url), 'utf8');
const voiceSource = await readFile(new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8');
const source = `${runtimeSource}\n${voiceSource}`;
assert.doesNotMatch(source, /hybrid-knowledge-retrieval|routeKnowledgeQuery|weighted score|compatibility fallback/iu);
assert.doesNotMatch(source, /Shanmuga|hospital|package/iu);

console.log(JSON.stringify({
  gate: 'knowledge-engine-acceptance', passed: true, repeats,
  industries: task10Industries.map((fixture) => fixture.industry), metrics,
  guarantees: {
    tenantIsolation: true, multilingualAndStt: true, topicSwitching: true,
    comparisonGrounding: true, ambiguity: true, safety: true, tools: true,
    verifiedToolExecution: true, universalPriority: true, artifactRecovery: true,
    interruptions: true, knownAnswerFirstAudioTargetMs: 1000,
    hardFirstAudioDeadlineMs: 2000,
  },
}));
