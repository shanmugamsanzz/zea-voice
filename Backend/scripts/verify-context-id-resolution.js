import assert from 'node:assert/strict';
import { resolveCallContextId } from '../src/voice/interaction/context-id-resolver.js';
import { parsePublicTaskInput, publicTaskSchema } from '../src/public-tasks/public-task.schemas.js';

function profile(contextId = null) {
  return { agent: { settings: {}, speech: { interaction: { contextId } } } };
}

const explicitOutbound = resolveCallContextId({
  call: {
    direction: 'outbound', from: '+918035088313', to: '+919489974421',
    providerMetadata: {
      context: { context_id: 'task:customer-123', lead_id: 'lead-ignored' },
      preCall: { context: { context_id: 'precall-ignored' } },
    },
  },
  runtimeProfile: profile(),
});
assert.equal(explicitOutbound.contextId, 'task:customer-123');
assert.equal(explicitOutbound.source, 'outbound_context_id');

const outboundCrm = resolveCallContextId({
  call: {
    direction: 'outbound', from: '+918035088313', to: '+919489974421',
    providerMetadata: {
      context: { lead_id: 'lead-456' },
      preCall: { context: { context_id: 'precall-lower-priority' } },
    },
  },
  runtimeProfile: profile('hospital'),
});
assert.equal(outboundCrm.contextId, 'hospital:lead:lead-456');
assert.equal(outboundCrm.source, 'outbound_crm_id');

const inboundPreCall = resolveCallContextId({
  call: {
    direction: 'inbound', from: '+919489974421', to: '+918035088313',
    providerMetadata: { preCall: { context: { contact_id: 'contact-789' } } },
  },
  runtimeProfile: profile(),
});
assert.equal(inboundPreCall.contextId, 'contact:contact-789');
assert.equal(inboundPreCall.source, 'precall_crm_id');

const phoneFallback = resolveCallContextId({
  call: {
    direction: 'inbound', from: '+91 94899 74421', to: '+918035088313', providerMetadata: {},
  },
  runtimeProfile: profile(),
});
assert.match(phoneFallback.contextId, /^phone:[a-f0-9]{32}$/);
assert.equal(phoneFallback.source, 'phone_fallback');
assert.doesNotMatch(phoneFallback.contextId, /94899/);
assert.equal(resolveCallContextId({
  call: { direction: 'inbound', from: '+919489974421', to: '+918035088313', providerMetadata: {} },
  runtimeProfile: profile(),
}).contextId, phoneFallback.contextId);

assert.throws(() => resolveCallContextId({
  call: { direction: 'inbound', from: 'invalid', to: 'invalid', providerMetadata: {} },
  runtimeProfile: profile(),
}), (error) => error.code === 'VOICE_CONTEXT_ID_UNRESOLVED');

const baseTask = {
  agent: '44444444-4444-4444-8444-444444444444',
  campaign: '55555555-5555-4555-8555-555555555555',
  phone: '+919489974421', from: '+918035088313',
  workspace_id: '22222222-2222-4222-8222-222222222222',
  retries: 0, intervals: [], context: {}, context_id: 'crm:lead-123',
};
assert.equal(parsePublicTaskInput(publicTaskSchema, baseTask).success, true);
assert.equal(parsePublicTaskInput(publicTaskSchema, { ...baseTask, context_id: 'bad context id' }).success, false);

console.log(JSON.stringify({ success: true, task: 'Call Context ID resolution' }));

