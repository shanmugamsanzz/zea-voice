import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { createAgentSchema } = await import('../src/agents/agent.schemas.js');
const { resolveLiveMemoryConfiguration } = await import('../src/voice/interaction/live-memory-config.js');
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
  kbA: '40000000-0000-4000-8000-000000000001',
  kbB: '40000000-0000-4000-8000-000000000002',
});

const settings = Object.freeze({
  cachePolicy: 'session_only',
  contextId: 'customer-session',
  conversationContextMode: 'last_n_turns',
  conversationContextTurns: 4,
  conversationMemoryFields: [{
    key: 'reference_code', label: 'Reference code', type: 'text', required: true,
    question: 'What is the reference code?', requiredAction: 'lookup_record',
  }],
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

function contract({ tenantId, workspaceId, agentId, knowledgeBaseId, prompt, language, voiceId }) {
  return buildCanonicalRuntimeConfiguration({
    row: runtimeRow({ tenantId, workspaceId, agentId, prompt, language, voiceId }),
    resolvedAgent: { agentId, tenantId, workspaceId, callDirection: 'inbound' },
    settings,
    knowledgeBases: [{
      id: knowledgeBaseId, usageDirection: 'both', priority: 1,
      publicationRevision: 7, semanticReady: true,
    }],
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
  agentId: identifiers.agentA, knowledgeBaseId: identifiers.kbA,
  prompt: 'Use the assigned published evidence.', language: 'en-IN', voiceId: 'voice-a',
});
const configurationB = contract({
  tenantId: identifiers.tenantB, workspaceId: identifiers.workspaceB,
  agentId: identifiers.agentB, knowledgeBaseId: identifiers.kbB,
  prompt: 'Follow this tenant configuration.', language: 'ta-IN', voiceId: 'voice-b',
});

// Agent Creation values survive runtime assembly without a second source.
assert.equal(configurationA.prompt.system, 'Use the assigned published evidence.');
assert.equal(configurationA.prompt.temperature, 0.2);
assert.equal(configurationA.memory.mode, settings.conversationContextMode);
assert.equal(configurationA.memory.recentTurns, settings.conversationContextTurns);
assert.deepEqual(configurationA.memory.fields.map((field) => ({ ...field })), settings.conversationMemoryFields);
assert.equal(configurationA.tools[0].name, 'lookup_record');
assert.deepEqual(configurationA.tools[0].inputSchema.required, ['reference_code']);
assert.equal(configurationA.speech.language, 'en-IN');
assert.equal(configurationA.speech.voiceId, 'voice-a');
assert.deepEqual([...configurationA.interruption.explicitStopPhrases], ['pause now']);
assert.equal(configurationA.closing.staticMessage, settings.postCallStaticMessage);
assert.deepEqual([...configurationA.closing.endTriggerPhrases], settings.callEndTriggerPhrases);
assert.equal(configurationA.knowledge.assignedPublishedRevisions[0].publicationRevision, 7);

// Scope and revision lists never bleed between tenants or workspaces.
assert.equal(configurationA.scope.tenantId, identifiers.tenantA);
assert.equal(configurationA.scope.workspaceId, identifiers.workspaceA);
assert.equal(configurationA.knowledge.assignedPublishedRevisions[0].knowledgeBaseId, identifiers.kbA);
assert.equal(configurationB.scope.tenantId, identifiers.tenantB);
assert.equal(configurationB.scope.workspaceId, identifiers.workspaceB);
assert.equal(configurationB.knowledge.assignedPublishedRevisions[0].knowledgeBaseId, identifiers.kbB);
assert.equal(JSON.stringify(configurationA).includes(identifiers.tenantB), false);
assert.equal(JSON.stringify(configurationB).includes(identifiers.tenantA), false);

// Backend validation remains authoritative for the same UI-owned fields.
assert.throws(
  () => resolveLiveMemoryConfiguration({
    conversationMemoryFields: [{ key: 'Invalid Key', label: 'Invalid', question: 'Value?' }],
  }, { strict: true }),
  (error) => error.code === 'VOICE_LIVE_MEMORY_CONFIG_INVALID',
);
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
  'prompt: agent.prompt', 'conversationMemoryFields: normalizedMemoryFields',
  'newToolInputSchema', 'knowledge-bases',
]) assert.match(uiSource, new RegExp(uiOwnedSetting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));

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
