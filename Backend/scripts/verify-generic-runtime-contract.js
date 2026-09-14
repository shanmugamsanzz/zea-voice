import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { createAgentSchema } = await import('../src/agents/agent.schemas.js');
const { normalizeLiveMemorySettings } = await import('../src/voice/interaction/live-memory-config.js');
const {
  buildCanonicalRuntimeConfiguration,
} = await import('../src/voice/providers/provider-config.js');

const identifiers = Object.freeze({
  tenantA: '10000000-0000-4000-8000-000000000001',
  tenantB: '10000000-0000-4000-8000-000000000002',
  workspaceA: '20000000-0000-4000-8000-000000000001',
  workspaceB: '20000000-0000-4000-8000-000000000002',
  agentA: '30000000-0000-4000-8000-000000000001',
  agentB: '30000000-0000-4000-8000-000000000002',
});

const settings = Object.freeze({
  cachePolicy: 'session_only',
  conversationContextMode: 'last_n_turns',
  conversationContextTurns: 4,
  timeBasedInterruptionEnabled: true,
  speechConfirmationDelayMs: 240,
  minimumMeaningfulWords: 2,
  acknowledgementPhrases: ['understood'],
  explicitStopPhrases: ['pause now'],
  postCallMessageType: 'Static',
  postCallPrompt: '',
  postCallStaticMessage: 'The conversation is complete.',
  callEndTriggerPhrases: ['finish conversation'],
  postCallUninterruptibleReasons: ['verified_completion'],
  postCallIncludePhoneNumbers: false,
});

function runtimeRow({ tenantId, workspaceId, agentId, prompt, language, voiceId }) {
  return {
    id: agentId,
    tenant_id: tenantId,
    workspace_id: workspaceId,
    usage_direction: 'both',
    prompt,
    welcome_message: 'Welcome.',
    temperature: '0.2',
    language,
    voice_id: voiceId,
    interruption_sensitivity: '0.3',
    stt_model_id: '50000000-0000-4000-8000-000000000001',
    llm_model_id: '50000000-0000-4000-8000-000000000002',
    tts_model_id: '50000000-0000-4000-8000-000000000003',
  };
}

function contract({ tenantId, workspaceId, agentId, prompt, language, voiceId }) {
  return buildCanonicalRuntimeConfiguration({
    row: runtimeRow({ tenantId, workspaceId, agentId, prompt, language, voiceId }),
    resolvedAgent: { agentId, tenantId, workspaceId, callDirection: 'inbound' },
    settings,
    runtimeTools: [{
      id: '60000000-0000-4000-8000-000000000001',
      name: 'lookup_record', type: 'webhook_api', description: 'Retrieve an approved current record.',
      configuration: {
        inputSchema: {
          type: 'object', properties: { reference_code: { type: 'string' } },
          required: ['reference_code'], additionalProperties: false,
        },
      },
    }],
    sttRuntimeSettings: { sttLanguage: language },
    ttsRuntimeSettings: { voiceId },
  });
}

const configurationA = contract({
  tenantId: identifiers.tenantA, workspaceId: identifiers.workspaceA,
  agentId: identifiers.agentA,
  prompt: 'Use the assigned published evidence.', language: 'en-IN', voiceId: 'voice-a',
});
const configurationB = contract({
  tenantId: identifiers.tenantB, workspaceId: identifiers.workspaceB,
  agentId: identifiers.agentB,
  prompt: 'Follow this tenant configuration.', language: 'ta-IN', voiceId: 'voice-b',
});

// Agent Creation values survive runtime assembly without a second source.
assert.equal(configurationA.prompt.system, 'Use the assigned published evidence.');
assert.equal(configurationA.prompt.temperature, 0.2);
assert.equal(configurationA.memory.mode, settings.conversationContextMode);
assert.equal(configurationA.memory.recentTurns, settings.conversationContextTurns);
assert.equal(Object.hasOwn(configurationA.memory, 'fields'), false);
assert.equal(configurationA.tools[0].name, 'lookup_record');
assert.deepEqual(configurationA.tools[0].inputSchema.required, ['reference_code']);
assert.equal(configurationA.speech.language, 'en-IN');
assert.equal(configurationA.speech.voiceId, 'voice-a');
assert.deepEqual([...configurationA.interruption.explicitStopPhrases], ['pause now']);
assert.equal(Object.hasOwn(configurationA, 'closing'), false);
assert.equal(JSON.stringify(configurationA).includes(settings.postCallStaticMessage), false);
assert.equal(JSON.stringify(configurationA).includes(settings.callEndTriggerPhrases[0]), false);
assert.equal(Object.hasOwn(configurationA, 'knowledge'), false);

// Scope and revision lists never bleed between tenants or workspaces.
assert.equal(configurationA.scope.tenantId, identifiers.tenantA);
assert.equal(configurationA.scope.workspaceId, identifiers.workspaceA);
assert.equal(configurationB.scope.tenantId, identifiers.tenantB);
assert.equal(configurationB.scope.workspaceId, identifiers.workspaceB);
assert.equal(JSON.stringify(configurationA).includes(identifiers.tenantB), false);
assert.equal(JSON.stringify(configurationB).includes(identifiers.tenantA), false);

// Removed UI-owned field and namespace settings are discarded by backend normalization.
const cleanedSettings = normalizeLiveMemorySettings({
  ...settings,
  contextId: 'legacy-namespace',
  conversationMemoryFields: [{ key: 'legacy_field' }],
});
assert.equal(Object.hasOwn(cleanedSettings, 'contextId'), false);
assert.equal(Object.hasOwn(cleanedSettings, 'conversationMemoryFields'), false);
const validAgent = createAgentSchema.safeParse({
  name: 'Generic Agent', language: 'en-IN', usageDirection: 'both', status: 'draft',
  sttModelId: '70000000-0000-4000-8000-000000000001',
  llmModelId: '70000000-0000-4000-8000-000000000002',
  ttsModelId: '70000000-0000-4000-8000-000000000003',
  voiceId: 'voice-a', prompt: 'Use assigned configuration.', settings,
});
assert.equal(validAgent.success, true);

const providerSource = fs.readFileSync(new URL('../src/voice/providers/provider-config.js', import.meta.url), 'utf8');
const uiSource = fs.readFileSync(new URL('../../Frontend/src/components/agent/AgentTabs.tsx', import.meta.url), 'utf8');
assert.match(providerSource, /a\.id=\$1 AND a\.tenant_id=\$2 AND a\.workspace_id=\$3/u);
for (const uiOwnedSetting of [
  'prompt: agent.prompt',
  'newToolInputSchema', 'AgentKnowledgeDocumentsPanel',
]) assert.match(uiSource, new RegExp(uiOwnedSetting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
assert.doesNotMatch(uiSource, /Context Namespace|Important Information Fields/u);

const businessDefaults = /(?:shanmuga|hospital|silver|gold|platinum|appointment|booking)/iu;
assert.doesNotMatch(providerSource, businessDefaults);
assert.doesNotMatch(JSON.stringify(configurationA), businessDefaults);

console.log(JSON.stringify({
  task: 'generic-runtime-contract',
  uiReadbackParity: true,
  backendValidation: true,
  tenantWorkspaceIsolation: true,
  businessDefaults: false,
}));
