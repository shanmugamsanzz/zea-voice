import assert from 'node:assert/strict';
import {
  isExactWorkflowResponse,
  routeKnowledgeQuery,
} from '../src/knowledge-bases/knowledge-runtime.service.js';
import { generateAgentResponse } from '../src/agents/agent-runtime.service.js';

const tenantId = '51b907f8-9ec9-48f8-bd00-39f72b392ab8';
const agentId = '33564c37-d2e8-45aa-a12f-7b39f66d9827';
const workflowBase = {
  knowledge_base_id: '6a9fe85d-b37f-45d4-8017-a43f75bb51d9',
  document_id: '2d9b6c3e-a184-4b22-b459-7d863191e055',
  document_version_id: '12ac1fc1-b661-4ae4-91ca-481f20ccffca',
  document_name: 'tenant-workflow-rules.txt',
  source_page_start: 1,
  source_page_end: 1,
  action_type: 'respond',
};
const workflows = [
  {
    ...workflowBase,
    id: 'ad5cbf00-3597-44dd-96b9-cf401535db4f',
    name: 'package_overview', intent: 'package_overview', priority: 10,
    conditions: { triggerPhrases: ['என்னென்ன packages இருக்கு', 'what packages do you have'], matchMode: 'any_phrase' },
    action_config: { responseMode: 'exact', instruction: 'Tenant configured exact answer.' },
    response_template: 'Tenant configured exact answer.',
  },
  {
    ...workflowBase,
    id: '17ed93ad-9799-49b4-87f7-1e04efc65abc',
    name: 'callback', intent: 'callback', priority: 20,
    conditions: { triggerPhrases: ['call me later'], matchMode: 'exact' },
    action_config: { responseMode: 'instruction', instruction: 'Ask for a callback time.' },
    response_template: 'Ask for a callback time.',
  },
];

let databaseCalls = 0;
let embedCalls = 0;
const dependencies = {
  cache: null,
  async contextRunner(auth, operation) {
    assert.equal(auth.tenantId, tenantId);
    return operation({
      async query(_sql, values) {
        databaseCalls += 1;
        assert.equal(values[0], tenantId);
        assert.equal(values[1], agentId);
        return { rows: [{
          agent_usage: 'both', knowledge_bases: [], workflows,
          conversations: [], catalog_items: [], faqs: [],
        }] };
      },
    });
  },
  async embed() { embedCalls += 1; return []; },
  async search() { return []; },
};
const auth = { tenantId, workspaceId: '9df7df18-2f83-465f-9658-8bf3e46541ec' };
const base = { agentId, usageDirection: 'inbound', language: 'ta', routeHint: 'auto' };

const exact = await routeKnowledgeQuery(auth, {
  ...base, query: 'சரி, என்னென்ன packages இருக்கு சொல்லுங்க',
}, dependencies);
assert.equal(exact.route, 'workflow');
assert.equal(exact.content, 'Tenant configured exact answer.');
assert.equal(exact.workflow.matchedPhrase, 'என்னென்ன packages இருக்கு');
assert.equal(exact.workflow.matchMode, 'any_phrase');
assert.equal(isExactWorkflowResponse(exact), true);

const instruction = await routeKnowledgeQuery(auth, {
  ...base, query: 'call me later',
}, dependencies);
assert.equal(instruction.route, 'workflow');
assert.equal(instruction.workflow.responseMode, 'instruction');
assert.equal(instruction.content, '');
assert.ok(instruction.workflow.instruction);
assert.equal(isExactWorkflowResponse(instruction), false);

const noExactSubstring = await routeKnowledgeQuery(auth, {
  ...base, query: 'please call me later tomorrow',
}, dependencies);
assert.equal(noExactSubstring.route, 'none');

assert.equal(databaseCalls, 3);
assert.equal(embedCalls, 0, 'Workflow matches must not call embedding search');

const runtimeAgentRow = {
  id: agentId,
  name: 'Tenant Agent',
  description: null,
  goal: null,
  language: 'Tamil',
  usage_direction: 'both',
  prompt: 'Use only tenant configuration.',
  welcome_message: 'Hello',
  temperature: 0.2,
  inactivity_timeout_seconds: 10,
  settings: {},
  model_id: 'f65a1e88-56d3-4285-a200-709e95705172',
  model_key: 'test-model',
  model_name: 'Test Model',
  model_settings: {},
  model_capabilities: {},
  provider_id: '710e0100-20c6-43d8-b760-b3fb3f682dfa',
  provider_name: 'Test Provider',
  base_url: 'https://example.test/v1',
  parameters: [{ key: 'OPENAI_API_KEY', plainValue: 'test-key', encryptedValue: null, isSecret: false }],
};
let llmCalls = 0;
const responseDependencies = {
  async contextRunner(_auth, operation) {
    return operation({ async query() { return { rowCount: 1, rows: [runtimeAgentRow] }; } });
  },
  async routeKnowledge(_auth, input) {
    return input.query === 'exact question' ? exact : instruction;
  },
  async invokeLlm() {
    llmCalls += 1;
    return {
      answer: 'Generated answer.', finishReason: 'stop', usage: {},
      providerRequestId: 'test-request', durationMs: 5,
    };
  },
};
const exactAgentResponse = await generateAgentResponse(auth, agentId, {
  event: 'message', query: 'exact question', usageDirection: 'inbound', history: [],
}, responseDependencies);
assert.equal(exactAgentResponse.answer, 'Tenant configured exact answer.');
assert.equal(exactAgentResponse.responseSource, 'workflow');
assert.equal(exactAgentResponse.llm, null);
assert.equal(llmCalls, 0);

const generatedAgentResponse = await generateAgentResponse(auth, agentId, {
  event: 'message', query: 'instruction question', usageDirection: 'inbound', history: [],
}, responseDependencies);
assert.equal(generatedAgentResponse.answer, 'Generated answer.');
assert.equal(generatedAgentResponse.responseSource, 'llm');
assert.equal(llmCalls, 1);

console.log('Generic Workflow Rules runtime and exact-response bypass verification passed.');
