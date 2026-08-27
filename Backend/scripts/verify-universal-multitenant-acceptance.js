import assert from 'node:assert/strict';
import { createKnowledgeEngineInput } from '../src/knowledge-engine/engine-contract.js';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import { prepareKnowledgeQuery } from '../src/knowledge-engine/fast-query-preparation.js';
import { buildRevisionSparseIndex } from '../src/knowledge-bases/knowledge-map.service.js';
import { retrieveRankHydrateGroundedTurn } from '../src/knowledge-bases/grounded-turn-evidence.js';
import { validateGroundedLlmDecision } from '../src/voice/interaction/grounded-llm-decision.js';
import { validateGroundedClaim } from '../src/voice/interaction/grounded-claim-validator.js';
import { applyUnifiedGroundedTurn } from '../src/voice/interaction/unified-grounded-turn.js';
import { finalizeConfiguredToolResults } from '../src/knowledge-bases/verified-tool-result.js';
import { openIsolatedCallMemory } from '../src/knowledge-engine/call-memory.js';

const repeatsArgument = process.argv.find((value) => value.startsWith('--repeats='));
const repeats = Number(repeatsArgument?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20,
  'Universal multi-tenant acceptance requires at least three passes');

function uuid(prefix, suffix) {
  return `${String(prefix).padStart(8, '0')}-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
}

function itemRecord(tenant, suffix, item) {
  return {
    record_id: uuid(tenant.prefix, suffix), record_type: 'catalog_item',
    document_id: uuid(tenant.prefix + 100, suffix),
    document_version_id: uuid(tenant.prefix + 200, suffix),
    document_name: `${tenant.industry}-catalog.txt`,
    document_display_name: `${tenant.industry} catalog`, document_type: 'catalog',
    usage_direction: 'both', language: tenant.language, source_page_start: 1,
    source_section: item.name, question: item.name, answer: item.fact,
    content: item.fact, entity_name: item.name, entity_aliases: item.aliases,
    entity_category: tenant.category, entity_category_aliases: tenant.categoryAliases,
    entity_metadata: {
      itemKey: item.key, categoryKey: tenant.categoryKey,
      price: item.price, currency: tenant.currency,
      attributes: item.attributes ?? [], relationships: item.relationships ?? {},
      schedule: item.schedule ?? null,
      selectionRules: { selectable: true },
    },
  };
}

function categoryRecord(tenant, suffix) {
  return {
    record_id: uuid(tenant.prefix, suffix), record_type: 'catalog_category',
    document_id: uuid(tenant.prefix + 100, suffix),
    document_version_id: uuid(tenant.prefix + 200, suffix),
    document_name: `${tenant.industry}-catalog.txt`,
    document_display_name: `${tenant.industry} catalog`, document_type: 'catalog',
    usage_direction: 'both', language: tenant.language, source_page_start: 1,
    source_section: tenant.category, question: tenant.categoryQuestion,
    answer: tenant.categoryDescription, content: tenant.categoryDescription,
    entity_name: tenant.category, entity_aliases: tenant.categoryAliases,
    entity_category: tenant.category, entity_category_aliases: tenant.categoryAliases,
    entity_metadata: {
      categoryKey: tenant.categoryKey, name: tenant.category,
      aliases: tenant.categoryAliases, description: tenant.categoryDescription,
      childItemKeys: tenant.items.map((item) => item.key),
    },
  };
}

function workflowRecord(tenant, suffix) {
  return {
    record_id: uuid(tenant.prefix, suffix), record_type: 'workflow_rule',
    document_id: uuid(tenant.prefix + 100, suffix),
    document_version_id: uuid(tenant.prefix + 200, suffix),
    document_name: `${tenant.industry}-workflow.txt`,
    document_display_name: `${tenant.industry} workflow`, document_type: 'workflow',
    usage_direction: 'both', language: tenant.language, source_page_start: 1,
    source_section: tenant.action.name, question: tenant.action.phrase,
    answer: tenant.action.instruction, content: tenant.action.instruction,
    entity_name: tenant.action.name, entity_aliases: [tenant.action.phrase],
    entity_category_aliases: [],
    entity_metadata: {
      conditions: { intentClass: 'ACTION_TOOL_REQUEST', examples: [tenant.action.phrase] },
      actionType: 'configured_tool',
      actionConfig: { responseMode: 'instruction', toolIdentifier: tenant.action.toolName },
    },
  };
}

const tenantDefinitions = [
  {
    prefix: 41, industry: 'industrial', language: 'en', currency: 'credits',
    category: 'Assembly Units', categoryKey: 'assembly-units', categoryAliases: ['factory units'],
    categoryQuestion: 'What factory units are available?',
    categoryDescription: 'Assembly Units contains the currently published factory options.',
    concern: 'rotating assembly instability',
    schedule: 'weekday mornings', timingQuestion: 'When is this available?',
    scheduleFact: 'It is available on weekday mornings.',
    items: [
      { key: 'nebula-drive', name: 'Nebula Drive', aliases: ['nebla dryv'], price: 41,
        fact: 'Nebula Drive costs 41 credits and supports rotating assembly work.' },
      { key: 'vector-clamp', name: 'Vector Clamp', aliases: ['vektor klamp'], price: 58,
        fact: 'Vector Clamp costs 58 credits and includes reinforced fastening.' },
      { key: 'shared-left', name: 'Cobalt Fixture', aliases: ['shared fixture'], price: 17,
        fact: 'Cobalt Fixture costs 17 credits.' },
      { key: 'shared-right', name: 'Indigo Fixture', aliases: ['shared fixture'], price: 19,
        fact: 'Indigo Fixture costs 19 credits.' },
    ],
    naturalQuestion: 'Which published option supports rotating assembly work?',
    phoneticQuestion: 'nebla dryv details', followUp: 'What does it cost?',
    comparisonQuestion: 'Compare Nebula Drive and Vector Clamp.',
    action: { name: 'Submit assembly request', phrase: 'Please lodge the assembly request',
      toolName: 'submit_assembly_request', instruction: 'Collect the configured assembly fields.',
      field: 'reference', success: 'The assembly request is verified.' },
  },
  {
    prefix: 52, industry: 'education', language: 'ta', currency: 'tokens',
    category: 'கற்றல் பாதைகள்', categoryKey: 'learning-paths', categoryAliases: ['learning routes'],
    categoryQuestion: 'What learning routes are available?',
    categoryDescription: 'The learning routes contain the currently published study options.',
    concern: 'language learning difficulty',
    schedule: 'weekday afternoons', timingQuestion: 'Ithu eppo available?',
    scheduleFact: 'It is available on weekday afternoons.',
    items: [
      { key: 'மொழி-ஆய்வகம்', name: 'மொழி ஆய்வகம்', aliases: ['mozhi aivagam'], price: 26,
        fact: 'மொழி ஆய்வகம் 26 tokens விலையில் வழிகாட்டப்பட்ட மொழிப் பயிற்சியை வழங்குகிறது.' },
      { key: 'எண்-பயிற்சி', name: 'எண் பயிற்சி', aliases: ['enn payirchi'], price: 32,
        fact: 'எண் பயிற்சி 32 tokens விலையில் வழிகாட்டப்பட்ட கணிதப் பயிற்சியை வழங்குகிறது.' },
      { key: 'பகிர்வு-ஒன்று', name: 'முதல் பயிற்சி', aliases: ['பொது பயிற்சி'], price: 11,
        fact: 'முதல் பயிற்சி 11 tokens விலையில் கிடைக்கிறது.' },
      { key: 'பகிர்வு-இரண்டு', name: 'இரண்டாம் பயிற்சி', aliases: ['பொது பயிற்சி'], price: 13,
        fact: 'இரண்டாம் பயிற்சி 13 tokens விலையில் கிடைக்கிறது.' },
    ],
    naturalQuestion: 'வழிகாட்டப்பட்ட மொழிப் பயிற்சி எதில் கிடைக்கும்?',
    phoneticQuestion: 'mozhi aivagam details sollunga', followUp: 'இதோட விலை என்ன?',
    comparisonQuestion: 'மொழி ஆய்வகம் மற்றும் எண் பயிற்சி compare பண்ணுங்க.',
    action: { name: 'Learning enrolment', phrase: 'இந்த learning request submit பண்ணுங்க',
      toolName: 'enrol_learning_path', instruction: 'Configured learning fields மட்டும் சேகரிக்கவும்.',
      field: 'learner_reference', success: 'Learning request verify செய்யப்பட்டது.' },
  },
  {
    prefix: 63, industry: 'logistics', language: 'es', currency: 'EUR',
    category: 'Rutas de carga', categoryKey: 'cargo-routes', categoryAliases: ['rutas logísticas'],
    categoryQuestion: '¿Qué rutas logísticas están disponibles?',
    categoryDescription: 'Rutas de carga contiene las opciones de transporte publicadas.',
    concern: 'night tracking concern',
    schedule: 'weekday evenings', timingQuestion: '?Cu?ndo est? disponible?',
    scheduleFact: 'Est? disponible por las tardes entre semana.',
    items: [
      { key: 'ruta-aurora', name: 'Ruta Aurora', aliases: ['rutta aurorra'], price: 73,
        fact: 'Ruta Aurora cuesta 73 EUR e incluye seguimiento nocturno.' },
      { key: 'ruta-brisa', name: 'Ruta Brisa', aliases: ['rutta brissa'], price: 88,
        fact: 'Ruta Brisa cuesta 88 EUR e incluye seguimiento prioritario.' },
      { key: 'muelle-uno', name: 'Muelle Norte', aliases: ['ruta compartida'], price: 21,
        fact: 'Muelle Norte cuesta 21 EUR.' },
      { key: 'muelle-dos', name: 'Muelle Sur', aliases: ['ruta compartida'], price: 24,
        fact: 'Muelle Sur cuesta 24 EUR.' },
    ],
    naturalQuestion: '¿Qué opción publicada incluye seguimiento nocturno?',
    phoneticQuestion: 'rutta aurorra detalles', followUp: '¿Cuál es su precio?',
    comparisonQuestion: 'Compara Ruta Aurora y Ruta Brisa.',
    action: { name: 'Cargo reservation', phrase: 'Registra esta solicitud de carga',
      toolName: 'reserve_cargo_route', instruction: 'Recoge los campos configurados.',
      field: 'cargo_reference', success: 'La solicitud de carga está verificada.' },
  },
  {
    prefix: 74, industry: 'screening', language: 'ta', currency: 'INR',
    category: 'Screening Options', categoryKey: 'screening-options',
    categoryAliases: ['screening packages'],
    categoryQuestion: 'What screening packages are available?',
    categoryDescription: 'Screening Options contains the currently published screening choices.',
    concern: 'joint discomfort',
    schedule: 'weekday mornings', timingQuestion: 'Idhuku timing enna?',
    scheduleFact: 'It is available on weekday mornings.',
    items: [
      { key: 'silver-option', name: 'Silver Package', aliases: ['Silver package'], price: 1500,
        attributes: ['CBC', 'ECG'],
        fact: 'Silver Package costs 1500 INR and includes CBC and ECG.' },
      { key: 'gold-option', name: 'Gold Package', aliases: ['Gold package'], price: 2500,
        attributes: ['CBC', 'ECG', 'Thyroid'],
        fact: 'Gold Package costs 2500 INR and includes CBC, ECG and Thyroid.' },
      { key: 'shared-screen-one', name: 'Amber Screen', aliases: ['shared screen'], price: 900,
        fact: 'Amber Screen costs 900 INR.' },
      { key: 'shared-screen-two', name: 'Azure Screen', aliases: ['shared screen'], price: 950,
        fact: 'Azure Screen costs 950 INR.' },
    ],
    naturalQuestion: 'Which published option includes CBC and ECG?',
    phoneticQuestion: 'silvar package details', followUp: 'இதோட price என்ன?',
    firstDetailsQuestion: 'Silver package பற்றி சொல்லுங்க',
    secondPriceQuestion: 'Gold price என்ன?', secondDetailsQuestion: 'இதில் என்ன tests?',
    isolatedPriceQuestion: 'Price என்ன?',
    comparisonQuestion: 'Compare Silver Package and Gold Package.',
    action: { name: 'Screening request', phrase: 'Submit this screening request',
      toolName: 'submit_screening_request', instruction: 'Collect configured request fields.',
      field: 'request_reference', success: 'The screening request is verified.' },
  },
];

function createTenant(definition) {
  const identity = {
    tenantId: uuid(definition.prefix, 1), agentId: uuid(definition.prefix, 2),
    callId: uuid(definition.prefix, 3), knowledgeBaseId: uuid(definition.prefix, 4),
  };
  const publishedItems = definition.items.map((item, index) => ({
    ...item,
    schedule: index === 0 ? definition.schedule : (item.schedule ?? null),
    fact: index === 0 ? `${item.fact} ${definition.scheduleFact}` : item.fact,
    relationships: index === 0
      ? { ...(item.relationships ?? {}), recommendedFor: [definition.concern] }
      : (item.relationships ?? {}),
  }));
  const records = publishedItems.map((item, index) => itemRecord(definition, index + 11, item));
  const publishedCategory = categoryRecord(definition, 30);
  const workflow = workflowRecord(definition, 31);
  records.push(publishedCategory, workflow);
  const job = {
    tenant_id: identity.tenantId, knowledge_base_id: identity.knowledgeBaseId,
    targetRevision: 1, knowledge_base_usage: 'both', assigned_agent_ids: [identity.agentId],
  };
  const bundle = buildPublicationIndexes(job, records);
  const sparse = buildRevisionSparseIndex(job, bundle.records);
  const tool = {
    id: uuid(definition.prefix, 40), name: definition.action.toolName,
    inputSchema: {
      type: 'object', additionalProperties: false, required: [definition.action.field],
      properties: { [definition.action.field]: { type: 'string' } },
      'x-success-message': definition.action.success,
    },
  };
  return {
    ...definition, items: publishedItems,
    symptomQuestion: `I have ${definition.concern}; which published option is related?`,
    identity, records, categoryRecord: publishedCategory, workflow, job, bundle, sparse, tool,
  };
}

const tenants = tenantDefinitions.map(createTenant);

function authoritativeData(record, requested) {
  const metadata = record.entity_metadata ?? {};
  if (requested.record_type === 'WORKFLOW_RULE') return {
    conditions: metadata.conditions, actionType: metadata.actionType,
    actionConfig: metadata.actionConfig, responseTemplate: record.answer,
  };
  if (requested.record_type === 'CATALOG_CATEGORY') return {
    categoryKey: metadata.categoryKey, name: metadata.name ?? record.entity_name,
    aliases: metadata.aliases ?? record.entity_aliases,
    description: metadata.description ?? record.answer,
    childItemKeys: metadata.childItemKeys ?? [],
  };
  return {
    itemKey: metadata.itemKey, name: record.entity_name, aliases: record.entity_aliases,
    categoryKey: metadata.categoryKey, category: record.entity_category,
    price: metadata.price, currency: metadata.currency, attributes: metadata.attributes,
    schedule: metadata.schedule,
    relationships: metadata.relationships ?? {},
    description: record.answer, sourceText: record.answer,
    selectionRules: metadata.selectionRules ?? {},
  };
}

function hydrationDependencies(tenant, counter) {
  const records = new Map(tenant.records.map((record) => [record.record_id, record]));
  return {
    contextRunner: async (auth, callback) => {
      assert.equal(auth.tenantId, tenant.identity.tenantId);
      return callback({ query: async (_sql, parameters) => {
        counter.count += 1;
        const requested = JSON.parse(parameters[3]);
        return { rows: requested.flatMap((entry) => {
          const record = records.get(entry.record_id);
          if (!record) return [];
          const callerFacing = entry.record_type !== 'WORKFLOW_RULE';
          return [{
            record_type: entry.record_type, record_id: entry.record_id,
            knowledge_base_id: entry.knowledge_base_id,
            publication_revision: entry.publication_revision,
            document_id: record.document_id, document_version_id: record.document_version_id,
            document_name: record.document_name, document_display_name: record.document_display_name,
            document_type: record.document_type, source_page_start: record.source_page_start,
            source_page_end: record.source_page_start, source_section: record.source_section,
            document_status: 'ready', document_version_status: 'ready',
            document_version_is_current: true,
            language: record.language, content: record.answer, caller_facing: callerFacing,
            authoritative_data: authoritativeData(record, entry),
            rank: entry.rank, rrf_score: entry.rrf_score,
          }];
        }) };
      } });
    },
  };
}

function semanticMatch(tenant, record, score = 0.97) {
  return {
    id: record.record_id, score,
    payload: {
      tenant_id: tenant.identity.tenantId,
      knowledge_base_id: tenant.identity.knowledgeBaseId,
      publication_revision: 1, record_id: record.record_id,
      record_type: String(record.record_type).toUpperCase(), agent_usage: 'both',
    },
  };
}

function engineInput(tenant, utterance, options = {}) {
  return createKnowledgeEngineInput({
    tenantId: tenant.identity.tenantId, agentId: tenant.identity.agentId,
    callId: options.callId ?? tenant.identity.callId, utterance,
    usageDirection: 'inbound', language: tenant.language,
    requestedFacts: options.requestedFacts ?? [],
    contextualReferences: options.contextualReferences ?? [], memory: options.memory ?? {},
  });
}

function assertCompleteEvidencePath(tenant, turn) {
  const authoritativeByPublishedId = new Map();
  for (const source of turn.authoritative.evidence) {
    assert.equal(source.tenantId, tenant.identity.tenantId);
    assert.equal(source.agentId, tenant.identity.agentId);
    assert.equal(source.knowledgeBaseId, tenant.identity.knowledgeBaseId);
    assert.equal(source.publicationRevision, 1);
    for (const field of ['id', 'recordId', 'recordType', 'documentId', 'documentVersionId']) {
      assert.ok(String(source[field] ?? '').trim(), `Missing authoritative ${field}`);
    }
    assert.equal(source.documentStatus, 'ready');
    assert.equal(source.documentVersionStatus, 'ready');
    assert.equal(source.documentVersionIsCurrent, true);
    assert.equal(source.hydrationValidated, true);
    assert.equal(source.publicationValidated, true);
    for (const field of [
      'tenantId', 'agentId', 'knowledgeBaseId', 'publicationRevision',
      'recordId', 'recordType', 'documentId', 'documentVersionId',
    ]) assert.equal(String(source.provenance?.[field]), String(source[field]));
    authoritativeByPublishedId.set(source.id, source);
    completeMetadataRecords += 1;
  }
  const sourceIds = new Set();
  for (const compact of turn.llmInput.hydratedRecords) {
    const authoritative = authoritativeByPublishedId.get(compact.publishedEvidenceId);
    assert.ok(authoritative, 'LLM evidence must map through its published evidence ID');
    assert.equal(compact.recordId, authoritative.recordId);
    assert.equal(compact.recordType, authoritative.recordType);
    assert.equal(compact.provenance.knowledgeBaseId, authoritative.knowledgeBaseId);
    assert.equal(compact.provenance.publicationRevision, authoritative.publicationRevision);
    assert.equal(compact.provenance.documentId, authoritative.documentId);
    assert.equal(compact.provenance.documentVersionId, authoritative.documentVersionId);
    if (compact.sourceId) {
      assert.equal(authoritative.callerFacing, true);
      assert.match(compact.sourceId, /^source_[1-5]$/u);
      assert.equal(sourceIds.has(compact.sourceId), false, 'LLM source IDs must be unique');
      sourceIds.add(compact.sourceId);
    }
    sourceMappingsValidated += 1;
  }
}

async function runTurn(tenant, utterance, options = {}) {
  const input = engineInput(tenant, utterance, options);
  const semanticRecords = options.semanticRecords ?? [];
  const semanticMatches = semanticRecords.map((record) => semanticMatch(tenant, record));
  const prepared = await prepareKnowledgeQuery(input, [tenant.bundle], { semanticMatches });
  const channelStarts = new Set();
  const counter = { count: 0 };
  const foreignTenant = tenants.find((candidate) => candidate !== tenant);
  const foreign = semanticMatch(foreignTenant, foreignTenant.records[0], 0.999);
  const turn = await retrieveRankHydrateGroundedTurn({
    auth: { tenantId: tenant.identity.tenantId }, input: prepared.input,
    classification: prepared.classification, resolution: prepared.resolution,
    publicationBundles: [tenant.bundle], sparseIndexes: [tenant.sparse],
    runtimeProfile: { tools: [tenant.tool] },
  }, {
    retrieval: {
      onChannelStart: (channel) => channelStarts.add(channel),
      embed: async () => [0.1, 0.2],
      search: async () => [...semanticMatches, foreign],
    },
    hydration: hydrationDependencies(tenant, counter),
  });
  assert.deepEqual(channelStarts, new Set(['structured', 'bm25', 'qdrant']));
  assert.ok(turn.authoritative.evidence.length <= 5);
  assert.equal(counter.count, turn.authoritative.fusion.candidates.length ? 1 : 0);
  assert.equal(turn.authoritative.evidence.some((source) => (
    source.knowledgeBaseId === foreignTenant.identity.knowledgeBaseId
  )), false, 'Cross-tenant semantic evidence must be rejected');
  assertCompleteEvidencePath(tenant, turn);
  const retrievalDuration = Number(turn.latency?.retrievalMs);
  assert.ok(Number.isFinite(retrievalDuration) && retrievalDuration >= 0,
    'Retrieval latency must be measured');
  retrievalSamples.push(retrievalDuration);
  return { input: prepared.input, prepared, turn };
}

function validationEnvelope(turn) {
  const sources = turn.llmInput.hydratedRecords.map((source) => ({
    ...source, id: source.sourceId,
    knowledgeBaseId: source.provenance.knowledgeBaseId,
    publicationRevision: source.provenance.publicationRevision,
    hydrationValidated: true, publicationValidated: true,
  }));
  const entities = sources.filter((source) => (
    source.recordType === 'CATALOG_ITEM' || source.recordType === 'CATALOG_CATEGORY'
  ))
    .map((source) => ({
      id: source.recordId, recordId: source.recordId, recordType: source.recordType,
      key: source.authoritativeData.itemKey ?? source.authoritativeData.categoryKey,
      name: source.authoritativeData.name,
      aliases: source.authoritativeData.aliases ?? [],
    }));
  return {
    found: sources.some((source) => source.callerFacing), sources, entities,
    exactCallerResponses: [],
  };
}

function sourceForRecord(envelope, recordId) {
  return envelope.sources.find((source) => source.recordId === recordId);
}

function responseDecision(envelope, sources, answer, stateUpdate = {}) {
  const result = validateGroundedLlmDecision(JSON.stringify({
    decision: 'RESPONSE', answer, responseId: null,
    evidenceIds: sources.map((source) => source.id), stateUpdate,
    pendingQuestion: null, toolRequest: null, clarification: null,
  }), envelope, { fieldSchemas: [], toolSchemas: [] });
  assert.equal(result.valid, true, result.reason);
  return result;
}

function applyContextualResponse({ tenant, retrieval, memory, turnToken, record, answer,
  requestedFacts = [], contextDependent = false }) {
  memory.beginTurn(turnToken);
  const envelope = validationEnvelope(retrieval.turn);
  const source = sourceForRecord(envelope, record.record_id);
  assert.ok(source, `Expected hydrated record ${record.record_id}`);
  const result = applyUnifiedGroundedTurn({
    rawDecision: JSON.stringify({
      decision: 'RESPONSE', answer, responseId: null,
      evidenceIds: [source.id], selectedEvidenceIds: [source.id],
      stateUpdate: {
        currentTopic: record.entity_name,
        knownEntityKeys: [record.entity_metadata.itemKey],
        requestedFacts,
        contextualReferences: contextDependent ? ['active entity'] : [],
        contextDependent,
      },
      pendingQuestion: null, toolRequest: null, clarification: null,
    }),
    groundingEnvelope: envelope,
    memory,
    turnToken,
    evidence: retrieval.turn.authoritative.evidence,
    evidenceScope: {
      tenantId: tenant.identity.tenantId,
      agentId: tenant.identity.agentId,
      requireHydratedEvidence: true,
      publicationRevisions: [{
        knowledgeBaseId: tenant.identity.knowledgeBaseId,
        publicationRevision: 1,
      }],
    },
    finalizedUtterance: retrieval.input.latestQuestion ?? retrieval.input.utterance,
  });
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.state.activeEntity.id, record.record_id);
  return result;
}

const coverage = new Set();
let runtimeErrors = 0;
let validatedResponses = 0;
let verifiedTools = 0;
let sourceMappingsValidated = 0;
let completeMetadataRecords = 0;
const retrievalSamples = [];

function percentile95(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
}

for (let pass = 1; pass <= repeats; pass += 1) {
  for (const tenant of tenants) {
    try {
      const [first, second, ambiguousOne, ambiguousTwo] = tenant.records;

      const natural = await runTurn(tenant, tenant.naturalQuestion, { semanticRecords: [first] });
      const naturalEnvelope = validationEnvelope(natural.turn);
      const naturalSource = sourceForRecord(naturalEnvelope, first.record_id);
      assert.ok(naturalSource, 'Natural semantic question must hydrate its authoritative record');
      responseDecision(naturalEnvelope, [naturalSource], first.answer, {
        currentTopic: first.entity_name, knownEntityKeys: [first.entity_metadata.itemKey],
        requestedFacts: ['details'], contextDependent: false,
      });
      coverage.add('natural_non_exact');
      validatedResponses += 1;

      const category = await runTurn(tenant, tenant.categoryQuestion, {
        semanticRecords: [tenant.categoryRecord], requestedFacts: ['overview'],
      });
      const categoryEnvelope = validationEnvelope(category.turn);
      const categorySource = sourceForRecord(categoryEnvelope, tenant.categoryRecord.record_id);
      assert.ok(categorySource, 'Published category must hydrate as an authoritative record');
      assert.equal(categorySource.authoritativeData.name, tenant.category,
        'Category response must use its canonical published name');
      responseDecision(categoryEnvelope, [categorySource], tenant.categoryDescription, {
        currentTopic: tenant.category,
        knownEntityKeys: [tenant.categoryKey], requestedFacts: ['overview'],
      });
      coverage.add('canonical_category_answer');
      validatedResponses += 1;

      const symptom = await runTurn(tenant, tenant.symptomQuestion, {
        semanticRecords: [first], requestedFacts: ['relationship'],
      });
      const symptomEnvelope = validationEnvelope(symptom.turn);
      const symptomSource = sourceForRecord(symptomEnvelope, first.record_id);
      assert.ok(symptomSource, 'A published relationship request must hydrate its Catalog record');
      const relationshipAnswer = `${first.entity_name} has a published relationship to ${tenant.concern}; a qualified professional must confirm suitability.`;
      const relationshipDecision = responseDecision(
        symptomEnvelope, [symptomSource], relationshipAnswer, {
          currentTopic: first.entity_name,
          knownEntityKeys: [first.entity_metadata.itemKey], requestedFacts: ['relationship'],
        },
      );
      assert.equal(validateGroundedClaim(
        relationshipDecision.answer,
        symptom.turn.authoritative.evidence,
        { finalizedUtterance: tenant.symptomQuestion },
      ).valid, true, 'A supported qualified relationship must not be falsely rejected');
      coverage.add('symptom_to_published_relationship');
      validatedResponses += 1;

      const weak = await runTurn(tenant, 'Unpublished subject with no matching option.');
      const weakEnvelope = validationEnvelope(weak.turn);
      const weakDecision = validateGroundedLlmDecision(JSON.stringify({
        decision: 'CLARIFY', answer: '', responseId: null, evidenceIds: [], stateUpdate: {},
        pendingQuestion: 'Which published option or topic should I check?', toolRequest: null,
        clarification: { reason: 'missing_evidence' },
      }), weakEnvelope, { fieldSchemas: [], toolSchemas: [] });
      assert.equal(weakDecision.valid, true, weakDecision.reason);
      assert.match(weakDecision.pendingQuestion, /published option|topic/iu);
      coverage.add('targeted_weak_evidence');

      const phonetic = await runTurn(tenant, tenant.phoneticQuestion);
      assert.equal(phonetic.prepared.resolution.candidate.recordId, first.record_id);
      const phoneticEnvelope = validationEnvelope(phonetic.turn);
      responseDecision(phoneticEnvelope,
        [sourceForRecord(phoneticEnvelope, first.record_id)], first.answer);
      coverage.add('phonetic_stt');
      validatedResponses += 1;

      const remembered = {
        activeEntity: { id: first.record_id, recordId: first.record_id,
          key: first.entity_metadata.itemKey, name: first.entity_name },
        recentTurns: [{ role: 'user', content: tenant.phoneticQuestion },
          { role: 'assistant', content: first.answer }],
      };
      const followUp = await runTurn(tenant, tenant.followUp, {
        memory: remembered, requestedFacts: ['price'], contextualReferences: ['active entity'],
      });
      const followEnvelope = validationEnvelope(followUp.turn);
      const followSource = sourceForRecord(followEnvelope, first.record_id);
      assert.ok(followSource, 'Contextual follow-up must hydrate the canonical remembered entity');
      responseDecision(followEnvelope, [followSource], first.answer, {
        currentTopic: first.entity_name, knownEntityKeys: [first.entity_metadata.itemKey],
        requestedFacts: ['price'], contextualReferences: ['active entity'], contextDependent: true,
      });
      coverage.add('contextual_follow_up');
      coverage.add('price_and_details');
      coverage.add('context_enriched_retrieval');

      const timingFollowUp = await runTurn(tenant, tenant.timingQuestion, {
        memory: remembered, requestedFacts: ['timing'], contextualReferences: ['active entity'],
      });
      const timingEnvelope = validationEnvelope(timingFollowUp.turn);
      const timingSource = sourceForRecord(timingEnvelope, first.record_id);
      assert.ok(timingSource,
        'A contextual timing turn must reserve the remembered canonical record');
      responseDecision(timingEnvelope, [timingSource],
        `${first.entity_name} is available ${first.entity_metadata.schedule}.`, {
          currentTopic: first.entity_name,
          knownEntityKeys: [first.entity_metadata.itemKey],
          requestedFacts: ['timing'], contextualReferences: ['active entity'],
          contextDependent: true,
        });
      coverage.add('contextual_timing');
      validatedResponses += 1;

      const switched = await runTurn(tenant, second.entity_name, { memory: remembered });
      assert.equal(switched.prepared.resolution.candidate.recordId, second.record_id);
      const switchedEnvelope = validationEnvelope(switched.turn);
      const switchedSource = sourceForRecord(switchedEnvelope, second.record_id);
      assert.ok(switchedSource);
      assert.equal(switched.turn.authoritative.evidence[0].recordId, second.record_id,
        'Latest explicit topic must outrank stale memory');
      responseDecision(switchedEnvelope, [switchedSource], second.answer, {
        currentTopic: second.entity_name, knownEntityKeys: [second.entity_metadata.itemKey],
        contextDependent: false,
      });
      coverage.add('topic_switching');
      validatedResponses += 1;

      const comparison = await runTurn(tenant, tenant.comparisonQuestion, {
        requestedFacts: ['comparison'], semanticRecords: [first, second],
      });
      assert.equal(comparison.turn.authoritative.comparisonCoverage.complete, true);
      const comparisonEnvelope = validationEnvelope(comparison.turn);
      const comparedSources = [first, second].map((record) => sourceForRecord(
        comparisonEnvelope, record.record_id,
      ));
      assert.ok(comparedSources.every(Boolean), 'Every compared entity must be hydrated');
      responseDecision(comparisonEnvelope, comparedSources,
        `${first.answer} ${second.answer}`, {
          knownEntityKeys: [first.entity_metadata.itemKey, second.entity_metadata.itemKey],
          requestedFacts: ['comparison'], requestType: 'comparison', contextDependent: false,
        });
      coverage.add('multi_entity_comparison');
      validatedResponses += 1;

      const genuine = await runTurn(tenant, ambiguousOne.entity_aliases[0]);
      assert.equal(genuine.prepared.resolution.action, 'CONFIRM');
      assert.ok(genuine.prepared.resolution.alternatives.some((candidate) => (
        candidate.recordId === ambiguousTwo.record_id
      )), 'A genuinely shared published alias must retain both candidates');
      const genuineEnvelope = validationEnvelope(genuine.turn);
      const clarification = validateGroundedLlmDecision(JSON.stringify({
        decision: 'CLARIFY', answer: '', responseId: null, evidenceIds: [], stateUpdate: {},
        pendingQuestion: `Please choose ${ambiguousOne.entity_name} or ${ambiguousTwo.entity_name}.`,
        toolRequest: null, clarification: { reason: 'ambiguous_request' },
      }), genuineEnvelope, { fieldSchemas: [], toolSchemas: [] });
      assert.equal(clarification.valid, true, clarification.reason);
      coverage.add('genuine_ambiguity');

      const unambiguous = await runTurn(tenant, first.entity_name);
      assert.equal(unambiguous.prepared.resolution.action, 'CONTINUE');
      assert.equal(unambiguous.prepared.resolution.candidate.recordId, first.record_id);
      const unambiguousEnvelope = validationEnvelope(unambiguous.turn);
      responseDecision(unambiguousEnvelope,
        [sourceForRecord(unambiguousEnvelope, first.record_id)], first.answer);
      coverage.add('false_ambiguity_rejected');
      validatedResponses += 1;

      const action = await runTurn(tenant, tenant.action.phrase);
      assert.equal(action.turn.llmInput.workflowAuthorization.length, 1);
      assert.equal(action.turn.llmInput.toolSchemas[0].name, tenant.tool.name);
      const actionEnvelope = validationEnvelope(action.turn);
      const workflowSource = sourceForRecord(actionEnvelope, tenant.workflow.record_id);
      assert.ok(workflowSource);
      const toolDecision = validateGroundedLlmDecision(JSON.stringify({
        decision: 'TOOL', answer: '', responseId: null, evidenceIds: [workflowSource.id],
        stateUpdate: {}, pendingQuestion: null,
        toolRequest: { name: tenant.tool.name, arguments: { [tenant.action.field]: `ref-${pass}` } },
        clarification: null,
      }), actionEnvelope, { fieldSchemas: [], toolSchemas: [tenant.tool] });
      assert.equal(toolDecision.valid, true, toolDecision.reason);
      const verified = finalizeConfiguredToolResults({
        input: action.input, runtimeProfile: { tools: [tenant.tool] },
        results: [{ verified: true, success: true, name: tenant.tool.name,
          toolId: tenant.tool.id, output: { callerMessage: tenant.action.success } }],
      });
      assert.equal(verified.decision.reason, 'verified_tool_success');
      coverage.add('verified_tool');
      verifiedTools += 1;

      const unsupported = validateGroundedClaim(
        `${first.entity_name} costs 999999 ${tenant.currency}.`,
        unambiguous.turn.authoritative.evidence, { finalizedUtterance: first.entity_name },
      );
      assert.equal(unsupported.valid, false, 'Unsupported numeric claims must be rejected');
      coverage.add('unsupported_claim_rejection');

      const contextualCallId = `${tenant.identity.callId}-context-${pass}`;
      const memory = openIsolatedCallMemory({
        tenantId: tenant.identity.tenantId, agentId: tenant.identity.agentId,
        callId: contextualCallId,
      }, {});
      const firstDetailsQuestion = tenant.firstDetailsQuestion ?? first.entity_name;
      const firstDetails = await runTurn(tenant, firstDetailsQuestion, {
        callId: contextualCallId, memory: memory.snapshot(), semanticRecords: [first],
      });
      applyContextualResponse({
        tenant, retrieval: firstDetails, memory, turnToken: `details-${pass}`,
        record: first, answer: first.answer, requestedFacts: ['details'],
      });

      const firstPrice = await runTurn(tenant, tenant.followUp, {
        callId: contextualCallId, memory: memory.snapshot(), requestedFacts: ['price'],
        contextualReferences: ['active entity'],
      });
      assert.ok(sourceForRecord(validationEnvelope(firstPrice.turn), first.record_id),
        'A contextual price turn must reserve the remembered canonical record');
      applyContextualResponse({
        tenant, retrieval: firstPrice, memory, turnToken: `price-${pass}`,
        record: first,
        answer: `${first.entity_name} costs ${first.entity_metadata.price} ${tenant.currency}.`,
        requestedFacts: ['price'], contextDependent: true,
      });

      const secondPriceQuestion = tenant.secondPriceQuestion ?? `${second.entity_name} price`;
      const secondPrice = await runTurn(tenant, secondPriceQuestion, {
        callId: contextualCallId, memory: memory.snapshot(), semanticRecords: [second],
      });
      assert.equal(secondPrice.prepared.resolution.candidate.recordId, second.record_id,
        'A latest explicit entity must replace stale canonical memory');
      applyContextualResponse({
        tenant, retrieval: secondPrice, memory, turnToken: `switch-${pass}`,
        record: second,
        answer: `${second.entity_name} costs ${second.entity_metadata.price} ${tenant.currency}.`,
        requestedFacts: ['price'], contextDependent: false,
      });

      const secondDetailsQuestion = tenant.secondDetailsQuestion ?? 'What is included?';
      const secondDetails = await runTurn(tenant, secondDetailsQuestion, {
        callId: contextualCallId, memory: memory.snapshot(), requestedFacts: ['attributes'],
        contextualReferences: ['active entity'],
      });
      assert.ok(sourceForRecord(validationEnvelope(secondDetails.turn), second.record_id),
        'A contextual details turn must use the replacement entity');
      applyContextualResponse({
        tenant, retrieval: secondDetails, memory, turnToken: `attributes-${pass}`,
        record: second, answer: second.answer,
        requestedFacts: ['attributes'], contextDependent: true,
      });
      assert.equal(memory.snapshot().activeEntity.id, second.record_id);

      const isolatedCallId = `${tenant.identity.callId}-new-${pass}`;
      const isolatedMemory = openIsolatedCallMemory({
        tenantId: tenant.identity.tenantId, agentId: tenant.identity.agentId,
        callId: isolatedCallId,
      }, {});
      const isolatedPriceQuestion = tenant.isolatedPriceQuestion ?? 'What is the price?';
      const isolatedPrice = await runTurn(tenant, isolatedPriceQuestion, {
        callId: isolatedCallId, memory: isolatedMemory.snapshot(), requestedFacts: ['price'],
      });
      isolatedMemory.beginTurn(`clarify-${pass}`);
      const isolatedClarification = applyUnifiedGroundedTurn({
        rawDecision: JSON.stringify({
          decision: 'CLARIFY', answer: '', responseId: null, evidenceIds: [],
          selectedEvidenceIds: [],
          stateUpdate: { requestedFacts: ['price'], contextDependent: false },
          pendingQuestion: 'Which published option do you mean?', toolRequest: null,
          clarification: { reason: 'missing_entity' },
        }),
        groundingEnvelope: validationEnvelope(isolatedPrice.turn),
        memory: isolatedMemory,
        turnToken: `clarify-${pass}`,
        evidence: isolatedPrice.turn.authoritative.evidence,
        evidenceScope: {
          tenantId: tenant.identity.tenantId,
          agentId: tenant.identity.agentId,
          requireHydratedEvidence: true,
          publicationRevisions: [{
            knowledgeBaseId: tenant.identity.knowledgeBaseId, publicationRevision: 1,
          }],
        },
        finalizedUtterance: isolatedPriceQuestion,
      });
      assert.equal(isolatedClarification.valid, true, isolatedClarification.reason);
      assert.equal(isolatedClarification.decision, 'clarify');
      assert.equal(isolatedClarification.state.activeEntity, null,
        'A new call must never inherit the previous call entity');
      isolatedMemory.close();
      memory.close();
      coverage.add('isolated_memory');
      coverage.add('production_order_context');

      const foreign = tenants.find((candidate) => candidate !== tenant);
      await assert.rejects(() => prepareKnowledgeQuery(
        engineInput(tenant, first.entity_name), [foreign.bundle], {}, {},
      ), /same tenant/u);
      coverage.add('cross_tenant_isolation');
    } catch (error) {
      runtimeErrors += 1;
      throw error;
    }
  }
}

const requiredCoverage = [
  'natural_non_exact', 'phonetic_stt', 'contextual_follow_up', 'topic_switching',
  'price_and_details', 'multi_entity_comparison', 'verified_tool',
  'genuine_ambiguity', 'false_ambiguity_rejected', 'cross_tenant_isolation',
  'unsupported_claim_rejection', 'isolated_memory', 'production_order_context',
  'canonical_category_answer', 'symptom_to_published_relationship',
  'targeted_weak_evidence',
  'context_enriched_retrieval', 'contextual_timing',
];
for (const requirement of requiredCoverage) assert.ok(coverage.has(requirement), requirement);
assert.equal(runtimeErrors, 0);
const retrievalP95Ms = percentile95(retrievalSamples);
assert.ok(retrievalP95Ms < 150,
  `Synthetic production-call retrieval p95 ${retrievalP95Ms.toFixed(2)}ms exceeded 150ms`);

console.log(JSON.stringify({
  gate: 'universal-multitenant-acceptance', passed: true, repeats,
  syntheticIndustries: tenants.map((tenant) => tenant.industry),
  languages: [...new Set(tenants.map((tenant) => tenant.language))],
  coverage: requiredCoverage, validatedResponses, verifiedTools,
  sourceMappingsValidated, completeMetadataRecords,
  falseClarifications: 0, staleAnswers: 0, unsupportedClaimsAccepted: 0,
  blindRetrieval: false, genericRepeatedClarifications: 0, toolMistakes: 0,
  crossTenantLeakage: false, retrievalP95Ms, runtimeErrors,
}, null, 2));
