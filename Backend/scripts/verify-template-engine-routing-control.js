import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildTemplateEngineRoutingPrompt,
  enforceTemplateEngineRuntimeInvariants,
  templateEngineRuntimeInvariants,
} from '../src/voice/interaction/template-engine-routing-control.js';

const tenantPrompt = [
  'Use RESPONSE for greetings.',
  'Use SEARCH for questions about published information.',
  'Use CLARIFY when the caller could mean multiple published options.',
  'Use TOOL for configured caller actions.',
  'Speak in the caller language with a concise and friendly tone.',
  'Use the configured unavailable response when information is missing.',
  'Phrase verified action results naturally.',
].join(' ');
const prompt = buildTemplateEngineRoutingPrompt({ mainPrompt: tenantPrompt });
assert.match(prompt, /<platform_invariants>/u);
assert.match(prompt, /<tenant_routing_authority>/u);
assert.match(prompt, /<tenant_main_prompt_json>/u);
assert.match(prompt, /<orchestrator_output_schema>/u);
assert.match(prompt, /Use RESPONSE for greetings/u);
assert.match(prompt, /optional retrieval preferences/u);
assert.match(prompt, /Conversational interaction management includes greetings/u);
assert.match(prompt, /requests to pause or wait/u);
assert.match(prompt, /agent is present or can hear the caller/u);
assert.match(prompt, /Previous references matter only when the latest utterance semantically refers/u);
assert.match(prompt, /Use TOOL only for an explicit external action/u);
assert.match(prompt, /externally verifiable fact must use SEARCH/u);
const postSearchPrompt = buildTemplateEngineRoutingPrompt({
  mainPrompt: tenantPrompt, phase: 'post_search',
});
assert.match(postSearchPrompt, /Never use NO_MATCH to repair missing, malformed or invalid citations/u);
assert.equal(templateEngineRuntimeInvariants.length, 4);
assert.throws(() => buildTemplateEngineRoutingPrompt({ mainPrompt: '' }),
  /tenant main prompt is required/u);

const response = {
  decision: 'RESPONSE', response: 'A concise factual response.',
  clarification: null, search: null, tool: null, nextQuestion: null, stateUpdate: null,
};
assert.equal(enforceTemplateEngineRuntimeInvariants(response, {
  tenantBoundaryVerified: true,
  factualClaimsPresent: true,
  verifiedEvidence: [],
}).reason, 'factual_response_requires_evidence');
assert.equal(enforceTemplateEngineRuntimeInvariants(response, {
  tenantBoundaryVerified: true,
  factualClaimsPresent: true,
  verifiedEvidence: [{ id: 'source-1' }],
}).valid, true);
assert.equal(enforceTemplateEngineRuntimeInvariants(response, {
  tenantBoundaryVerified: false,
  factualClaimsPresent: false,
}).reason, 'tenant_boundary_unverified');

const tool = {
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'configured_action', arguments: {} }, nextQuestion: null, stateUpdate: null,
};
assert.equal(enforceTemplateEngineRuntimeInvariants(tool, {
  tenantBoundaryVerified: true,
  workflowAuthorizedTools: ['configured_action'],
  assignedToolSchemas: [{ name: 'another_action' }],
}).reason, 'tool_not_authorized');
assert.equal(enforceTemplateEngineRuntimeInvariants(tool, {
  tenantBoundaryVerified: true,
  workflowAuthorizedTools: ['configured_action'],
  assignedToolSchemas: [{ name: 'configured_action' }],
}).valid, true);
assert.equal(enforceTemplateEngineRuntimeInvariants(response, {
  tenantBoundaryVerified: true,
  toolSuccessClaimed: true,
  verifiedToolResult: { verified: false, success: true },
}).reason, 'tool_success_unverified');
assert.equal(enforceTemplateEngineRuntimeInvariants(response, {
  tenantBoundaryVerified: true,
  toolSuccessClaimed: true,
  verifiedToolResult: { verified: true, success: true },
}).valid, true);

const source = readFileSync(new URL(
  '../src/voice/interaction/template-engine-routing-control.js', import.meta.url,
), 'utf8').toLocaleLowerCase();
for (const forbidden of ['hospital', 'package', 'crm', 'booking', 'appointment', 'patient']) {
  assert.equal(source.includes(forbidden), false, `Routing control contains domain vocabulary: ${forbidden}`);
}

console.log('Template-engine routing control verification passed.');
