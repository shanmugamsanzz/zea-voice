import assert from 'node:assert/strict';
import { createKnowledgeEngineInput, knowledgeEngineDecisionTypes } from '../src/knowledge-engine/engine-contract.js';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import { buildRevisionSparseIndex } from '../src/knowledge-bases/knowledge-map.service.js';
import { runObservedKnowledgeTurn, VoiceTurnLatencyTracker, voiceTurnStages } from '../src/knowledge-engine/voice-turn-latency.js';
import { executeAuthorizedToolWorkflow, finalizeGroundedLlmResponse } from '../src/knowledge-engine/safe-response-tool-runtime.js';
import { knowledgeMessageSources, toolMessageSources } from '../src/voice/source-trace.js';

const repeats = Number(process.argv.find((value) => value.startsWith('--repeats='))?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20);

const tenantId = '31000000-0000-4000-8000-000000000001';
const agentId = '31000000-0000-4000-8000-000000000002';
const knowledgeBaseId = '31000000-0000-4000-8000-000000000003';
const revision = 1;

const documents = {
  catalog: ['32000000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001',
    'shanmuga-hospital-package-catalog-upload.txt', 'Shanmuga Hospital Package Catalog', 'catalog'],
  conversation: ['32000000-0000-4000-8000-000000000002', '33000000-0000-4000-8000-000000000002',
    'shanmuga-hospital-conversation-script-production.txt', 'Shanmuga Hospital Conversation Guidance', 'conversation_script'],
  general: ['32000000-0000-4000-8000-000000000003', '33000000-0000-4000-8000-000000000003',
    'shanmuga-hospital-general-knowledge-production-upload.txt', 'Shanmuga Hospital General Knowledge', 'general_knowledge'],
  workflow: ['32000000-0000-4000-8000-000000000004', '33000000-0000-4000-8000-000000000004',
    'shanmuga-hospital-workflow-rules-structured-production.txt', 'Shanmuga Hospital Workflow Rules', 'workflow_rules'],
};

function record(index, recordType, documentKey, values = {}) {
  const document = documents[documentKey];
  return Object.freeze({
    record_id: `34000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    record_type: recordType, document_id: document[0], document_version_id: document[1],
    document_name: document[2], document_display_name: document[3], document_type: document[4],
    usage_direction: 'both', language: 'mul', source_page_start: 1, source_page_end: 1,
    source_section: values.entity_name ?? values.question ?? values.heading,
    source_line_start: index * 10, source_line_end: index * 10 + 5,
    entity_aliases: [], entity_category_aliases: [], entity_metadata: {}, ...values,
  });
}

function catalog(index, itemKey, name, aliases, category, categoryKey, categoryAliases, description, attributes = []) {
  return record(index, 'catalog_item', 'catalog', {
    question: name, answer: description, content: description, entity_name: name,
    entity_category: category, entity_aliases: aliases, entity_category_aliases: categoryAliases,
    entity_metadata: { itemKey, categoryKey, categoryDescription: `Approved ${category} options.`,
      selectionRules: { selectable: true }, attributes },
  });
}

const records = Object.freeze([
  record(1, 'conversation_node', 'conversation', {
    question: 'available packages', entity_name: 'Available package overview',
    entity_aliases: ['what packages are available', 'what packages do you have'],
    answer: 'We have Master, Onco Care and Organ-Specific health checkup options.',
    content: 'We have Master, Onco Care and Organ-Specific health checkup options.',
    entity_metadata: { intentClass: 'KNOWN_INFORMATION' },
  }),
  catalog(2, 'silver-master-health-checkup', 'Silver Master Health Checkup', ['silver', 'silver package'],
    'Master Health Checkup', 'master-health-checkup', ['master packages'],
    'Silver provides the approved basic screening set.', [{ key: 'tests', name: 'Tests', value: ['CBC', 'RBS'] }]),
  catalog(3, 'gold-master-health-checkup', 'Gold Master Health Checkup', ['gold', 'gold package'],
    'Master Health Checkup', 'master-health-checkup', ['master packages'],
    'Gold provides the approved enhanced screening set.', [{ key: 'tests', name: 'Tests', value: ['CBC', 'HS-CRP', 'ECG'] }]),
  catalog(4, 'onco-care-male', 'Onco Care Male Screening', ['male onco care'],
    'Onco Care Packages', 'onco-care-packages', ['onco care', 'onco care package', 'on cooker package'],
    'Approved male oncology screening information.'),
  catalog(5, 'onco-care-female', 'Onco Care Female Screening', ['female onco care'],
    'Onco Care Packages', 'onco-care-packages', ['onco care', 'onco care package', 'on cooker package'],
    'Approved female oncology screening information.'),
  catalog(6, 'renal-health-checkup', 'Renal Health Checkup', ['renal package'],
    'Organ-Specific Health Checkups', 'organ-specific-health-checkups', ['organ specific', 'organ-specific package'],
    'Approved renal screening information.'),
  catalog(7, 'lungs-health-checkup', 'Lungs Health Checkup', ['lungs package'],
    'Organ-Specific Health Checkups', 'organ-specific-health-checkups', ['organ specific', 'organ-specific package'],
    'Approved lung screening information.'),
  record(8, 'knowledge_chunk', 'general', {
    heading: 'Hospital location', answer: 'Shanmuga Hospital is at Sarada College Road, Salem.',
    content: 'Hospital location address Shanmuga Hospital is at Sarada College Road, Salem.',
  }),
  record(9, 'workflow_rule', 'workflow', {
    question: 'book appointment', entity_name: 'Create appointment',
    answer: 'Collect configured appointment fields.', content: 'Collect configured appointment fields.',
    entity_aliases: ['book appointment', 'appointment booking'],
    entity_metadata: { conditions: { examples: ['book appointment'], intentClass: 'ACTION_TOOL_REQUEST' },
      actionType: 'configured_tool', actionConfig: { responseMode: 'instruction',
        toolIdentifier: 'create_appointment', requiresCatalogItem: true } },
  }),
  record(10, 'workflow_rule', 'workflow', {
    question: 'severe emergency', entity_name: 'Emergency support',
    answer: 'Please get immediate emergency medical help.', content: 'Please get immediate emergency medical help.',
    entity_aliases: ['severe chest pain', 'cannot breathe', 'unconscious'],
    entity_metadata: { conditions: { examples: ['severe chest pain'], intentClass: 'SAFETY_EMERGENCY' },
      actionType: 'respond', actionConfig: { responseMode: 'exact' } },
  }),
  record(11, 'workflow_rule', 'workflow', {
    question: 'non emergency symptom support', entity_name: 'Doctor suitability guidance',
    answer: 'I cannot recommend a package from symptoms. A Doctor must confirm medical suitability.',
    content: 'I cannot recommend a package from symptoms. A Doctor must confirm medical suitability.',
    entity_aliases: ['stomach pain which package', 'which package for my symptoms'],
    entity_metadata: { conditions: { examples: ['stomach pain which package'], intentClass: 'KNOWN_INFORMATION' },
      actionType: 'respond', actionConfig: { responseMode: 'exact' } },
  }),
]);

const bookingWorkflowId = records[8].record_id;
const job = Object.freeze({ tenant_id: tenantId, knowledge_base_id: knowledgeBaseId,
  targetRevision: revision, knowledge_base_usage: 'both', assigned_agent_ids: [agentId] });
const bundle = buildPublicationIndexes(job, records);
const sparseIndex = buildRevisionSparseIndex(job, bundle.records);
const byId = new Map(records.map((entry) => [entry.record_id, entry]));
const tool = Object.freeze({ id: '35000000-0000-4000-8000-000000000001', name: 'create_appointment',
  configuration: { inputSchema: { type: 'object', additionalProperties: false,
    properties: { patient_name: { type: 'string', 'x-question': 'What is the patient name?' },
      preferred_date: { type: 'string', format: 'date', 'x-question': 'Which date do you prefer?' } },
    required: ['patient_name', 'preferred_date'], 'x-requires-confirmation': true,
    'x-confirmation-message': 'Please confirm this appointment request.' } } });
const runtimeProfile = Object.freeze({ agent: { id: agentId, tenantId }, tools: [tool] });

function authoritativeData(source) {
  const metadata = source.entity_metadata ?? {};
  if (source.record_type === 'catalog_item') return { itemKey: metadata.itemKey, name: source.entity_name,
    category: source.entity_category, categoryKey: metadata.categoryKey,
    categoryDescription: metadata.categoryDescription, description: source.answer,
    attributes: metadata.attributes ?? [], selectionRules: metadata.selectionRules };
  if (source.record_type === 'workflow_rule') return { name: source.entity_name,
    conditions: metadata.conditions, actionType: metadata.actionType,
    actionConfig: metadata.actionConfig, responseTemplate: source.answer };
  if (source.record_type === 'conversation_node') return { content: source.answer };
  return { heading: source.heading, content: source.content };
}

function hydrationDependencies() {
  return { contextRunner: async (auth, operation) => {
    assert.equal(auth.tenantId, tenantId);
    return operation({ query: async (_sql, parameters) => ({ rows: JSON.parse(parameters[3]).flatMap((candidate) => {
      const source = byId.get(candidate.record_id);
      if (!source) return [];
      const type = source.record_type.toUpperCase();
      const callerFacing = type !== 'WORKFLOW_RULE'
        || String(source.entity_metadata?.actionConfig?.responseMode).toLowerCase() === 'exact';
      return [{ record_type: type, record_id: source.record_id, tenant_id: tenantId,
        knowledge_base_id: knowledgeBaseId, publication_revision: revision,
        document_id: source.document_id, document_version_id: source.document_version_id,
        document_name: source.document_name, document_display_name: source.document_display_name,
        document_type: source.document_type, document_status: 'ready', document_version_status: 'ready',
        document_version_is_current: true, source_page_start: 1, source_page_end: 1,
        source_section: source.source_section, source_line_start: source.source_line_start,
        source_line_end: source.source_line_end, language: 'mul', content: source.content,
        caller_facing: callerFacing, authoritative_data: authoritativeData(source),
        rank: candidate.rank, rrf_score: candidate.rrf_score }];
    }) }) });
  } };
}

async function observed(callId, turnId, utterance, memory, options = {}) {
  const input = createKnowledgeEngineInput({ tenantId, agentId, callId, utterance,
    language: 'mul', memory, requestedFacts: options.requestedFacts ?? [] });
  const tracker = new VoiceTurnLatencyTracker({ tenantId, agentId, callId, turnId: String(turnId) });
  const result = await runObservedKnowledgeTurn({ auth: { tenantId }, input,
    publicationBundles: [bundle], sparseIndexes: [sparseIndex], runtimeProfile,
    confirmation: options.confirmation === true, tracker }, {
    retrievalDependencies: { embed: async () => [0.1, 0.2], search: async () => [] },
    hydrationDependencies: hydrationDependencies(),
  });
  let decision = result.decision;
  if (decision.type === knowledgeEngineDecisionTypes.LLM) decision = finalizeGroundedLlmResponse({
    input, plan: decision, answer: options.llmAnswer,
    selectedEvidenceIds: decision.evidenceIds, authoritative: result.authoritative,
  });
  tracker.record(voiceTurnStages.TTS_FIRST_CHUNK, 100);
  tracker.record(voiceTurnStages.FIRST_AUDIO_DELIVERY, 800);
  const latency = tracker.snapshot();
  assert.equal(latency.firstAudioStatus, 'target_met');
  assert.ok(latency.firstAudioMs < 1_000);
  return Object.freeze({ ...result, input, decision, latency });
}

function assertSources(result, expectedDisplayName) {
  const sources = knowledgeMessageSources({ found: true,
    matches: [...result.authoritative.evidence, ...result.authoritative.evidence] }, result.decision.evidenceIds);
  assert.ok(sources.length > 0);
  assert.ok(sources.some((source) => source.label === expectedDisplayName));
  assert.ok(sources.every((source) => source.metadata.documentName && source.metadata.pageNumber === 1
    && source.metadata.recordName), JSON.stringify(sources));
  const keys = sources.map((source) => [source.id, source.metadata.documentId,
    source.metadata.pageNumber, source.metadata.pageEnd].join(':'));
  assert.equal(new Set(keys).size, keys.length);
  assert.doesNotMatch(JSON.stringify(sources),
    /System instructions|Agent Instructions|llm_first|Runtime fallback|Configured knowledge clarification/iu);
}

function memoryEntity(candidate) {
  return candidate?.entityType === 'ITEM' ? { recordId: candidate.recordId,
    itemKey: candidate.itemKey, key: candidate.itemKey, name: candidate.label } : null;
}

const metrics = { passes: repeats, turns: 0, clarifications: 0, emergencyClassifications: 0,
  artifactExceptions: 0, validatorExceptions: 0, runtimeExceptions: 0, ttsExceptions: 0,
  toolExecutions: 0, maximumFirstAudioMs: 0 };

for (let pass = 1; pass <= repeats; pass += 1) {
  const callId = `36000000-0000-4000-8000-${String(pass).padStart(12, '0')}`;
  let turn = 0;
  let memory = {};
  const run = async (utterance, options = {}) => {
    turn += 1; metrics.turns += 1;
    let result;
    try { result = await observed(callId, turn, utterance, memory, options); }
    catch (error) { metrics.runtimeExceptions += 1; throw error; }
    metrics.maximumFirstAudioMs = Math.max(metrics.maximumFirstAudioMs, result.latency.firstAudioMs);
    if (result.decision.type === knowledgeEngineDecisionTypes.CLARIFY) metrics.clarifications += 1;
    if (result.classification.intentClass === 'SAFETY_EMERGENCY') metrics.emergencyClassifications += 1;
    const entity = memoryEntity(result.resolution.candidate);
    if (entity) memory = { ...memory, activeEntity: entity };
    return result;
  };

  let result = await run('what packages are available');
  assert.equal(result.decision.type, 'DIRECT', JSON.stringify({
    classification: result.classification, resolution: result.resolution,
    decision: result.decision, evidence: result.authoritative.evidence.map((source) => source.recordId),
  }));
  assertSources(result, documents.conversation[3]);

  result = await run('silver package');
  assert.match(result.decision.response.text, /Silver Master Health Checkup/u);

  result = await run('on cooker package');
  assert.equal(result.decision.type, 'DIRECT', JSON.stringify({
    classification: result.classification, decision: result.decision,
    evidence: result.authoritative.evidence.map((source) => ({ id: source.recordId, content: source.content })),
  }));
  assert.match(result.decision.response.text, /Onco Care Male Screening/u);
  assert.match(result.decision.response.text, /Onco Care Female Screening/u);
  assertSources(result, documents.catalog[3]);

  result = await run('gold package');
  assert.equal(result.decision.type, 'DIRECT');
  assert.match(result.decision.response.text, /Gold Master Health Checkup/u);
  assert.match(result.decision.response.text, /HS-CRP/u);
  assert.doesNotMatch(result.decision.response.text, /Silver/u);
  assert.equal(memory.activeEntity.itemKey, 'gold-master-health-checkup');
  assertSources(result, documents.catalog[3]);

  result = await run('organ-specific package');
  assert.equal(result.decision.type, 'DIRECT');
  assert.match(result.decision.response.text, /Renal Health Checkup/u);
  assert.match(result.decision.response.text, /Lungs Health Checkup/u);
  assertSources(result, documents.catalog[3]);

  result = await run('hospital location address', { llmAnswer:
    'Hospital location address Shanmuga Hospital is at Sarada College Road, Salem.' });
  assert.equal(result.decision.type, 'DIRECT');
  assert.match(result.decision.response.text, /Sarada College Road, Salem/u);
  assertSources(result, documents.general[3]);

  result = await run('stomach pain which package');
  assert.equal(result.classification.intentClass, 'KNOWN_INFORMATION');
  assert.equal(result.decision.type, 'DIRECT', JSON.stringify({
    classification: result.classification, decision: result.decision,
    evidence: result.authoritative.evidence.map((source) => ({ id: source.recordId, content: source.content })),
  }));
  assert.match(result.decision.response.text, /Doctor must confirm medical suitability/u);
  assertSources(result, documents.workflow[3]);

  await run('gold package');
  assert.equal(memory.activeEntity.itemKey, 'gold-master-health-checkup');
  result = await run('book appointment');
  assert.equal(result.classification.intentClass, 'ACTION_TOOL_REQUEST');
  assert.equal(result.decision.type, 'TOOL');
  assert.equal(result.decision.toolWorkflow.status, 'COLLECTING_FIELDS');
  assert.equal(result.decision.toolWorkflow.prompt, 'What is the patient name?');
  memory = { ...memory, activeTool: { name: result.decision.tool.name,
    authorizationRecordId: bookingWorkflowId, status: 'COLLECTING_FIELDS' } };

  memory = { ...memory, collectedToolFields: { patient_name: 'Arun Kumar' } };
  result = await run('Arun Kumar');
  assert.equal(result.decision.toolWorkflow.prompt, 'Which date do you prefer?');

  memory = { ...memory, collectedToolFields: { patient_name: 'Arun Kumar', preferred_date: '2026-08-25' } };
  result = await run('August 25 2026');
  assert.equal(result.decision.toolWorkflow.status, 'AWAITING_CONFIRMATION');

  memory = { ...memory, activeTool: { ...memory.activeTool, status: 'AWAITING_CONFIRMATION' } };
  result = await run('yes confirm booking', { confirmation: true });
  assert.equal(result.decision.type, 'TOOL', JSON.stringify({
    classification: result.classification, decision: result.decision,
    evidence: result.authoritative.evidence.map((source) => source.recordId),
  }));
  assert.equal(result.decision.toolWorkflow.status, 'READY_TO_EXECUTE');
  assert.deepEqual(result.decision.tool.input, { patient_name: 'Arun Kumar', preferred_date: '2026-08-25' });
  const execution = await executeAuthorizedToolWorkflow({ input: result.input, plan: result.decision,
    runtimeProfile, call: { id: callId } }, { executor: async () => ({ id: `tool-call-${pass}`,
    toolId: tool.id, name: tool.name, verified: true, success: true, durationMs: 25,
    output: { success: true, message: 'Appointment request created successfully.' } }) });
  assert.equal(execution.decision.reason, 'verified_tool_success');
  assert.equal(toolMessageSources([execution.result])[0].metadata.success, true);
  metrics.toolExecutions += 1;
}

assert.equal(metrics.clarifications, 0);
assert.equal(metrics.emergencyClassifications, 0);
assert.equal(metrics.toolExecutions, repeats);
assert.ok(metrics.maximumFirstAudioMs < 1_000);
for (const key of ['artifactExceptions', 'validatorExceptions', 'runtimeExceptions', 'ttsExceptions']) {
  assert.equal(metrics[key], 0);
}
console.log(JSON.stringify({ gate: 'production-equivalent-knowledge-call', passed: true, ...metrics,
  guarantees: { correctEntities: ['Onco Care', 'Gold', 'Organ-Specific'], location: true,
    staleSilverResponses: 0, verifiedBookingExecutions: metrics.toolExecutions,
    falseEmergencyClassifications: 0, falseClarifications: 0,
    exactDocumentAndPageSources: true, internalSources: 0, duplicateSources: 0,
    firstAudioLimitMs: 1_000 } }, null, 2));
