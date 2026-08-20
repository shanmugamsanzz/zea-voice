import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { withPlatformAdminContext } from '../src/infrastructure/database-context.js';
import { closeDatabase } from '../src/infrastructure/database.js';
import {
  loadPublishedKnowledgeMap, retrieveTenantEvidence,
} from '../src/knowledge-bases/knowledge-runtime.service.js';
import { loadAgentRuntimeProfile } from '../src/voice/providers/provider-config.js';
import { runtimeTools } from '../src/voice/providers/llm/llm-response.service.js';
import { validateGroundedClaim } from '../src/voice/interaction/grounded-claim-validator.js';
import { mergeToolFieldSchemas } from '../src/voice/interaction/tool-field-schema.js';
import { generateTenantRegressionScenarios } from './lib/tenant-regression-scenarios.js';

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((entry) => entry.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function required(value, name) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function recordId(source) {
  return String(source?.recordId ?? source?.id ?? '');
}

function catalogSources(result) {
  return (result?.sources ?? []).filter((source) => source.recordType === 'CATALOG_ITEM');
}

function actionSources(result) {
  return [...(result?.actionEvidence ?? []), ...(result?.sources ?? [])].filter((source) => (
    source.recordType === 'WORKFLOW_RULE' && source.activationAllowed === true
  ));
}

function toolIdentity(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, '_').replace(/^_+|_+$/gu, '');
}

function toolForWorkflow(source, assignedTools) {
  const config = source?.authoritativeData?.actionConfig ?? {};
  const expected = toolIdentity(config.toolIdentifier ?? config.actionKey);
  return assignedTools.find((tool) => (
    [tool.id, tool.name].map(toolIdentity).includes(expected)
  )) ?? null;
}

async function resolveAgent(agentId) {
  return withPlatformAdminContext(null, async (client) => {
    const result = await client.query(
      `SELECT id, tenant_id, workspace_id, usage_direction
         FROM voice_agents
        WHERE id=$1 AND status='active' AND deleted_at IS NULL`,
      [agentId],
    );
    assert.equal(result.rowCount, 1, 'Regression agent must be active');
    return result.rows[0];
  });
}

const agentId = required(argument('agent-id', process.env.PRODUCTION_ACCEPTANCE_AGENT_ID),
  '--agent-id or PRODUCTION_ACCEPTANCE_AGENT_ID');
const fixturePath = resolve(argument('fixture-file',
  'fixtures/complete-live-call-2026-08-20-regression.json'));
const reportPath = resolve(argument('report-file', 'artifacts/tenant-regression-report.json'));
const executionLimit = Math.max(1, Number(argument('execution-limit', '80')) || 80);
const liveCall = JSON.parse(await readFile(fixturePath, 'utf8'));
const agent = await resolveAgent(agentId);
const direction = agent.usage_direction === 'outbound' ? 'outbound' : 'inbound';
const resolvedAgent = {
  agentId: agent.id, tenantId: agent.tenant_id, workspaceId: agent.workspace_id,
  callDirection: direction,
};
const auth = {
  tenantId: agent.tenant_id, workspaceId: agent.workspace_id,
  userId: null, role: 'COMPANY_DEVELOPER',
};
const profile = await loadAgentRuntimeProfile(resolvedAgent);
const tools = runtimeTools(profile.tools);
const published = await loadPublishedKnowledgeMap(auth, {
  agentId: agent.id, usageDirection: direction,
});
assert.ok(published.records.length > 0, 'Assigned published tenant data is required');
const suite = generateTenantRegressionScenarios({ records: published.records, tools, liveCall });
const executable = suite.scenarios.filter((scenario) => !['live_call', 'topic_change'].includes(scenario.kind))
  .slice(0, executionLimit);
const results = [];

async function retrieve(query, language = 'und', memory = {}) {
  return retrieveTenantEvidence(auth, {
    agentId: agent.id, query, usageDirection: direction, language,
    routeHint: 'auto', knownEntities: memory.knownEntities ?? [],
    currentTopic: memory.currentTopic ?? null,
    selectedCatalogItemKey: memory.selectedCatalogItemKey ?? null,
    pendingQuestion: memory.pendingQuestion ?? null,
  });
}

try {
  for (const scenario of executable) {
    const evidence = await retrieve(scenario.utterance, scenario.language);
    const hydratedIds = new Set((evidence.sources ?? []).map(recordId));
    if (['entity', 'stt_variation'].includes(scenario.kind)) {
      assert.ok(scenario.expectedRecordIds.some((id) => hydratedIds.has(id)),
        `${scenario.id}: expected tenant Catalog item was not hydrated`);
    }
    if (scenario.kind === 'category') {
      assert.ok(scenario.expectedRecordIds.some((id) => hydratedIds.has(id)),
        `${scenario.id}: expected tenant Catalog category was not hydrated`);
    }
    if (scenario.kind === 'comparison') {
      assert.ok(scenario.expectedRecordIds.every((id) => hydratedIds.has(id)),
        `${scenario.id}: both compared Catalog items must be hydrated`);
    }
    if (scenario.kind === 'safety') {
      const selected = catalogSources(evidence);
      assert.ok(selected.length > 0, `${scenario.id}: tenant Catalog safety context was not hydrated`);
      const label = selected[0]?.authoritativeData?.name ?? 'This option';
      const unsafe = validateGroundedClaim(
        `${label} is best and medically suitable for your symptoms.`, selected,
        { finalizedUtterance: scenario.utterance },
      );
      assert.equal(unsafe.valid, false, `${scenario.id}: unsafe suitability recommendation passed`);
    }
    if (scenario.kind === 'configured_action') {
      assert.ok(actionSources(evidence).some((source) => recordId(source) === scenario.workflowRecordId),
        `${scenario.id}: configured Workflow did not authorize the action`);
      const tool = tools.find((candidate) => candidate.id === scenario.toolId
        || candidate.name === scenario.toolName);
      assert.ok(tool, `${scenario.id}: assigned tool is missing`);
      const fields = mergeToolFieldSchemas([], [tool]);
      assert.ok(scenario.requiredFields.every((key) => fields.some((field) => field.key === key)),
        `${scenario.id}: required tool fields were not derived from its schema`);
    }
    results.push({ id: scenario.id, kind: scenario.kind, passed: true });
  }

  const replay = suite.scenarios.find((scenario) => scenario.kind === 'live_call');
  assert.equal(replay.turns.length, liveCall.source.callerTurnCount);
  const memory = { knownEntities: [], currentTopic: null, selectedCatalogItemKey: null,
    pendingQuestion: liveCall.initialPendingQuestion ?? null };
  for (const [index, turn] of replay.turns.entries()) {
    const evidence = await retrieve(turn.utterance, replay.language, memory);
    const catalog = catalogSources(evidence);
    if (['tenant_entity', 'stt_tenant_entity', 'tenant_category', 'topic_change'].includes(turn.expect)) {
      assert.ok(catalog.length > 0, `complete live call turn ${index + 1}: Catalog evidence missing`);
    }
    if (turn.expect === 'comparison') {
      assert.ok(catalog.length >= Number(turn.minimumEntities ?? 2),
        `complete live call turn ${index + 1}: comparison evidence is incomplete`);
    }
    if (turn.safety === 'no_symptom_suitability') {
      const label = catalog[0]?.authoritativeData?.name ?? 'This option';
      const unsafe = validateGroundedClaim(`${label} is best for your symptoms.`, catalog,
        { finalizedUtterance: turn.utterance });
      assert.equal(unsafe.valid, false,
        `complete live call turn ${index + 1}: symptom recommendation was not blocked`);
    }
    if (turn.expect === 'configured_action') {
      const authorizations = actionSources(evidence);
      assert.ok(authorizations.length > 0,
        `complete live call turn ${index + 1}: no Workflow-authorized action was selected`);
      const actionTool = authorizations.map((source) => toolForWorkflow(source, tools)).find(Boolean);
      assert.ok(actionTool,
        `complete live call turn ${index + 1}: Workflow tool is not assigned to the agent`);
      if (turn.requiresConfirmation === true) {
        assert.equal(actionTool.inputSchema?.['x-requires-confirmation'], true,
          `complete live call turn ${index + 1}: action schema must require confirmation`);
      }
      assert.equal(turn.requiresVerifiedSuccess, true,
        `complete live call turn ${index + 1}: verified success must remain mandatory`);
    }
    if (catalog[0]) {
      const data = catalog[0].authoritativeData ?? {};
      memory.knownEntities = [{ key: data.itemKey, name: data.name, category: data.category }];
      memory.currentTopic = data.name ?? memory.currentTopic;
      memory.selectedCatalogItemKey = data.itemKey ?? memory.selectedCatalogItemKey;
    }
    results.push({ id: `complete-live-call-turn-${index + 1}`, kind: turn.expect, passed: true });
  }

  const report = {
    generatedAt: new Date().toISOString(), agentId: agent.id,
    generatedFromPublishedRecords: suite.generatedFromPublishedRecords,
    recordCounts: suite.recordCounts, coverage: suite.coverage,
    generatedScenarioCount: suite.scenarios.length,
    executedScenarioCount: results.length,
    completeLiveCallTurns: replay.turns.length,
    passed: true, results,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await closeDatabase();
}
