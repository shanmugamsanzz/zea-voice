import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compactGroundedDecisionInput } from '../src/agents/agent-runtime.service.js';
import { buildContextEnrichedRetrievalQuery } from '../src/knowledge-engine/targeted-retrieval.js';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const agentId = 'a0000000-0000-4000-8000-000000000002';
const callId = 'a0000000-0000-4000-8000-000000000003';
const primaryId = 'a0000000-0000-4000-8000-000000000011';
const comparisonId = 'a0000000-0000-4000-8000-000000000012';

const input = {
  tenantId,
  agentId,
  callId,
  usageDirection: 'inbound',
  utterance: 'Tell me naturally how these two choices differ',
  latestQuestion: 'Tell me naturally how these two choices differ',
  requestedFacts: ['comparison'],
  queryUnderstanding: {
    intentHint: 'COMPARISON',
    explicitEntities: [
      { recordId: primaryId, recordType: 'CATALOG_ITEM', name: 'Canonical Alpha' },
      { recordId: comparisonId, recordType: 'CATALOG_ITEM', name: 'Canonical Beta' },
    ],
    explicitCategories: [],
    comparisonEntities: [
      { recordId: primaryId, recordType: 'CATALOG_ITEM', name: 'Canonical Alpha' },
      { recordId: comparisonId, recordType: 'CATALOG_ITEM', name: 'Canonical Beta' },
    ],
    requestedFacts: ['comparison'],
    contextualReferences: [],
    contextDependent: false,
    need: { detected: false },
  },
};

const recordScope = new Map([
  [primaryId, {
    canonicalName: 'Canonical Alpha',
    searchForms: ['tenant alias alpha', 'spoken alpha', 'phonetic alpha'],
  }],
  [comparisonId, {
    canonicalName: 'Canonical Beta',
    searchForms: ['tenant alias beta', 'spoken beta', 'phonetic beta'],
  }],
]);
const classification = {
  selectedNamespace: 'CATALOG',
  relevantNamespaces: ['CATALOG'],
  retrievalPlan: { namespace: 'CATALOG' },
};
const resolution = { contextDependent: false };
const scope = [{ id: 'a0000000-0000-4000-8000-000000000020', publicationRevision: 3 }];

const query = buildContextEnrichedRetrievalQuery(
  input, classification, resolution, scope, recordScope,
);
assert.equal(query.currentQuestion, input.latestQuestion);
assert.deepEqual(new Set(query.tenantSearchForms), new Set([
  'Canonical Alpha', 'tenant alias alpha', 'spoken alpha', 'phonetic alpha',
  'Canonical Beta', 'tenant alias beta', 'spoken beta', 'phonetic beta',
]));
assert.match(query.sparseText, /Tell me naturally how these two choices differ/u);
assert.match(query.sparseText, /tenant alias alpha/u);
assert.match(query.semanticText, /phonetic beta/u);
assert.deepEqual(new Set(query.reservedRecords.map((record) => record.recordId)),
  new Set([primaryId, comparisonId]));

const compact = JSON.parse(compactGroundedDecisionInput({
  currentQuestion: input.latestQuestion,
  recentRelevantTurns: [
    { role: 'user', content: 'Earlier natural question' },
    { role: 'assistant', content: 'Earlier grounded answer' },
  ],
  canonicalMemory: { activeEntity: { recordId: primaryId, name: 'Canonical Alpha' } },
  meaning: {
    authority: 'GROUNDED_LLM',
    interpretationRequired: true,
    intentHint: 'COMPARISON',
    explicitEntities: input.queryUnderstanding.explicitEntities,
    comparisonEntities: input.queryUnderstanding.comparisonEntities,
    requestedFactHint: 'comparison',
    actionHint: { detected: false },
    ambiguityHint: { detected: false },
  },
  requestedFact: 'comparison',
  hydratedRecords: [],
  workflowAuthorization: [],
  toolSchemas: [],
  zeroEvidencePolicy: {},
}, 8_000));
assert.equal(compact.relevantMemory.meaning.authority, 'GROUNDED_LLM');
assert.equal(compact.relevantMemory.meaning.interpretationRequired, true);
assert.equal(compact.relevantMemory.meaning.comparisonEntities.length, 2);

const contextualSource = fs.readFileSync(
  new URL('../src/knowledge-engine/contextual-query-understanding.js', import.meta.url), 'utf8',
);
assert.doesNotMatch(contextualSource, /currentQuestion\.includes/u,
  'Normal-turn meaning hints must not route by exact caller sentence');
assert.match(contextualSource, /decisionAuthority:\s*false/u);
assert.match(contextualSource, /meaningAuthority:\s*'GROUNDED_LLM'/u);

console.log('Meaning-driven tenant hybrid retrieval and grounded prompt contract verified.');
