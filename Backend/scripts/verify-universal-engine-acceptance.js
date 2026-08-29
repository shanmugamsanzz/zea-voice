import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildAgentSystemPrompt } from '../src/agents/agent-runtime.service.js';
import {
  configuredOperationalFailureResponse,
} from '../src/voice/realtime-conversation-orchestrator.js';

const repeatsArgument = process.argv.find((value) => value.startsWith('--repeats='));
const repeats = Number(repeatsArgument?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20,
  'Universal engine acceptance requires at least three passes');

function run(name, file, args = []) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 300_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, [
    `${name} failed`, result.stdout, result.stderr,
  ].filter(Boolean).join('\n'));
  return String(result.stdout ?? '').trim();
}

const tenants = Object.freeze([
  Object.freeze({
    key: 'fabrication', language: 'en',
    tenantId: 'e1000000-0000-4000-8000-000000000001',
    technical: 'Configured technical response for tenant one.',
  }),
  Object.freeze({
    key: 'learning', language: 'ta',
    tenantId: 'e2000000-0000-4000-8000-000000000001',
    technical: 'Tenant two configured technical response.',
  }),
  Object.freeze({
    key: 'navigation', language: 'es',
    tenantId: 'e3000000-0000-4000-8000-000000000001',
    technical: 'Respuesta técnica configurada para el tenant tres.',
  }),
]);

const scenarios = Object.freeze([
  Object.freeze({ key: 'direct', question: 'Explain the selected published option.', fact: 'details' }),
  Object.freeze({
    key: 'need', question: 'Which option supports my stated operational need?',
    fact: 'recommendation', need: {
      detected: true, customerProblem: 'distributed work is difficult to coordinate',
      desiredOutcome: 'coordinated published capability',
    },
  }),
  Object.freeze({ key: 'context', question: 'What is its configured value?', fact: 'price' }),
  Object.freeze({ key: 'topic_change', question: 'Tell me about the newly selected option.', fact: 'details' }),
  Object.freeze({ key: 'comparison', question: 'Compare both selected options.', fact: 'comparison' }),
  Object.freeze({ key: 'ambiguity', question: 'Did I mean the first or second option?', fact: 'clarification' }),
  Object.freeze({ key: 'tool', question: 'Submit the authorized request.', fact: 'action' }),
  Object.freeze({ key: 'failure', question: 'Retry the information request.', fact: 'details' }),
]);

function largeRecord(tenant, index, required, reason) {
  const suffix = String(index + 1);
  return Object.freeze({
    sourceId: `source_${suffix}`,
    publishedEvidenceId: `${tenant.key}:published:${suffix}`,
    recordId: `${tenant.key}:record:${suffix}`,
    recordType: index === 4 ? 'WORKFLOW_RULE' : 'CATALOG_ITEM',
    canonicalName: `${tenant.key} canonical option ${suffix}`,
    required,
    reservationReasons: required ? Object.freeze([reason]) : Object.freeze([]),
    facts: Object.freeze({
      name: `${tenant.key} canonical option ${suffix}`,
      description: `Authoritative large fact ${suffix}. ${'published detail '.repeat(1_500)}`,
      configuredValue: index * 17 + 11,
      capabilities: Array.from({ length: 40 }, (_, entry) => ({
        key: `capability_${entry}`,
        value: `tenant-scoped-value-${entry}-${'x'.repeat(120)}`,
      })),
    }),
  });
}

function requiredIndexes(scenario) {
  if (scenario.key === 'comparison') return new Map([
    [0, 'explicit_comparison'], [1, 'explicit_comparison'],
  ]);
  if (scenario.key === 'context') return new Map([[2, 'canonical_memory']]);
  if (scenario.key === 'tool') return new Map([[4, 'workflow_authorization']]);
  return new Map([[0, scenario.key === 'need' ? 'published_use_case' : 'explicit_entity']]);
}

function extract(prompt, tag) {
  const match = new RegExp(`<${tag}>\\n([\\s\\S]+?)\\n</${tag}>`, 'u').exec(prompt);
  assert.ok(match, `${tag} must be complete`);
  return JSON.parse(match[1]);
}

let promptCases = 0;
let mandatoryRecordsVerified = 0;
let toolSchemasVerified = 0;
for (let pass = 1; pass <= repeats; pass += 1) {
  for (const tenant of tenants) {
    for (const scenario of scenarios) {
      const required = requiredIndexes(scenario);
      const records = Array.from({ length: 5 }, (_, index) => largeRecord(
        tenant, index, required.has(index), required.get(index),
      ));
      const toolSchemas = scenario.key === 'tool' ? [{
        name: `${tenant.key}_configured_action`,
        authorizationEvidenceId: 'source_5',
        inputSchema: {
          type: 'object', additionalProperties: false,
          required: ['reference'],
          properties: { reference: { type: 'string' } },
        },
      }] : [];
      const prompt = buildAgentSystemPrompt({
        name: `${tenant.key} synthetic agent`,
        language: tenant.language,
        prompt: 'Tenant instructions remain optional under grounded compact mode.',
        settings: { technicalFailureMessage: tenant.technical },
      }, {
        usageDirection: 'inbound',
        maxPromptChars: 4_000,
        context: {
          groundedResponseMode: true,
          compactGrounding: true,
          groundedDecisionInput: {
            currentQuestion: scenario.question,
            requestedFact: scenario.fact,
            need: scenario.need ?? null,
            recentRelevantTurns: Array.from({ length: 10 }, (_, index) => ({
              role: index % 2 ? 'assistant' : 'user',
              content: `Relevant complete turn ${index + 1} ${'history '.repeat(150)}`,
            })),
            canonicalMemory: {
              activeEntity: {
                recordId: `${tenant.key}:record:3`,
                name: `${tenant.key} canonical option 3`,
              },
              comparisonEntities: scenario.key === 'comparison'
                ? records.slice(0, 2).map((record) => ({
                  recordId: record.recordId, name: record.canonicalName,
                })) : [],
              collectedInformation: { tenantScopedReference: `${tenant.key}-${pass}` },
            },
            ambiguityCandidates: scenario.key === 'ambiguity'
              ? records.slice(0, 2).map((record) => ({
                recordId: record.recordId, name: record.canonicalName,
              })) : [],
            hydratedRecords: records,
            workflowAuthorization: scenario.key === 'tool'
              ? [{ workflowEvidenceId: 'source_5', toolName: toolSchemas[0].name }] : [],
            toolSchemas,
          },
        },
      });
      assert.ok(prompt.length <= 4_000, 'Prompt must remain within the configured budget');
      const packaged = extract(prompt, 'grounded_turn_input');
      const contract = extract(prompt, 'grounded_response_contract');
      assert.equal(packaged.currentQuestion, scenario.question,
        'The complete current question must survive compaction');
      const packagedIds = packaged.verifiedRecords.map((record) => record.sourceId);
      assert.equal(new Set(packagedIds).size, packagedIds.length,
        'Packaged evidence must not contain duplicate source IDs');
      assert.deepEqual([...contract.selectedEvidenceIds].sort(), [...packagedIds].sort(),
        'The response contract must expose exactly the packaged evidence IDs');
      for (const [index] of required) {
        const expected = records[index];
        assert.ok(packaged.verifiedRecords.some((record) => (
          record.recordId === expected.recordId && record.required === true
        )), `Mandatory evidence was removed for ${scenario.key}`);
        mandatoryRecordsVerified += 1;
      }
      assert.ok(packaged.verifiedRecords.every((record) => (
        String(record.recordId).startsWith(`${tenant.key}:`)
      )), 'Cross-tenant evidence entered the grounded prompt');
      if (scenario.key === 'tool') {
        assert.deepEqual(packaged.assignedToolSchemas.map((tool) => tool.name),
          [toolSchemas[0].name]);
        assert.deepEqual(contract.authorizedTools, [toolSchemas[0].name]);
        toolSchemasVerified += 1;
      }
      assert.equal(configuredOperationalFailureResponse({
        agent: { settings: { technicalFailureMessage: tenant.technical } },
      }), tenant.technical, 'Operational recovery must always have configured speech');
      promptCases += 1;
    }
  }
}

const needBased = run(
  'tenant-driven need-based retrieval',
  'scripts/verify-need-based-use-case-retrieval.js',
);
assert.match(needBased,
  /Universal need understanding and tenant-driven use-case retrieval verified\./u);

const production = JSON.parse(run(
  'universal production regression',
  'scripts/verify-universal-production-regression.js',
  [`--repeats=${repeats}`],
));
assert.equal(production.passed, true);
assert.equal(production.repeats, repeats);
assert.equal(production.directQuestions, true);
assert.equal(production.contextualFollowUps, true);
assert.equal(production.explicitTopicSwitching, true);
assert.equal(production.comparisons, true);
assert.ok(production.authorizedActionsVerified > 0);
assert.ok(production.configuredTechnicalRecoveries > 0);
assert.ok(production.finalAnswersAfterAcknowledgement > 0);
assert.equal(production.processingTimeInactivityPrompts, 0);
assert.equal(production.hardcodedBusinessVocabulary, false);
assert.equal(production.crossTenantLeakage, false);
assert.equal(production.staleAnswers, 0);
assert.equal(production.emptyEvidenceAccepted, 0);
assert.equal(production.falseClarifications, 0);
assert.equal(production.runtimeFailures, 0);
assert.equal(production.runtimeErrors, 0);
assert.equal(production.audioFailures, 0);

const zeroEvidence = JSON.parse(run(
  'zero-evidence multi-tenant regression',
  'scripts/verify-zero-evidence-multitenant.js',
  [`--repeats=${repeats}`],
));
assert.equal(zeroEvidence.passed, true);
assert.equal(zeroEvidence.llmDecisions, zeroEvidence.turns);
assert.ok(zeroEvidence.targetedClarifications > 0);
assert.ok(zeroEvidence.configuredSupportResponses > 0);
assert.ok(zeroEvidence.authorizedTools > 0);
assert.equal(zeroEvidence.hallucinationsAccepted, 0);
assert.equal(zeroEvidence.falseValidationRejections, 0);
assert.equal(zeroEvidence.silentTurns, 0);
assert.equal(zeroEvidence.crossTenantLeakage, false);

console.log(JSON.stringify({
  gate: 'universal-engine-acceptance',
  passed: true,
  repeats,
  syntheticTenants: tenants.length,
  syntheticIndustries: tenants.map((tenant) => tenant.key),
  languages: tenants.map((tenant) => tenant.language),
  scenarios: scenarios.map((scenario) => scenario.key),
  largeRecordPromptCases: promptCases,
  mandatoryRecordsVerified,
  toolSchemasVerified,
  zeroEvidenceTurns: zeroEvidence.turns,
  zeroEvidenceLlmDecisions: zeroEvidence.llmDecisions,
  maximumPromptCharacters: 4_000,
  duplicateEvidence: 0,
  hardcodedBusinessVocabulary: false,
  crossTenantLeakage: false,
  silentTurns: 0,
  groundingErrors: 0,
  runtimeErrors: 0,
  ttsErrors: 0,
}, null, 2));
