import { withPlatformAdminContext } from '../../infrastructure/database-context.js';
import { AppError } from '../../middleware/errors.js';
import { decryptCredential } from '../../security/credential-crypto.js';

const defaultContextRunner = (operation) => withPlatformAdminContext(null, operation);

function parameterMap(rows, decrypt) {
  return Object.fromEntries((rows ?? []).map((row) => [
    row.key,
    row.isSecret ? decrypt(row.encryptedValue) : row.plainValue,
  ]));
}

const secretSettingKey = /(api[_.-]?key|token|secret|password|credential|auth)/i;

function providerRuntimeDefaults(parameters) {
  return Object.fromEntries(Object.entries(parameters)
    .filter(([key]) => !secretSettingKey.test(key)));
}

function selectedSettings(settings, keys) {
  return Object.fromEntries(keys
    .filter((key) => Object.hasOwn(settings, key))
    .map((key) => [key, settings[key]]));
}

function provider(row, prefix, decrypt, runtimeSettings = {}) {
  const modelSettings = row[`${prefix}_model_settings`] ?? {};
  const parameters = parameterMap(row[`${prefix}_parameters`], decrypt);
  return {
    providerId: row[`${prefix}_provider_id`],
    providerName: row[`${prefix}_provider_name`],
    providerSlug: row[`${prefix}_provider_slug`],
    baseUrl: row[`${prefix}_base_url`],
    modelId: row[`${prefix}_model_id`],
    modelKey: row[`${prefix}_model_key`],
    modelName: row[`${prefix}_model_name`],
    modelSettings,
    modelCapabilities: row[`${prefix}_model_capabilities`] ?? {},
    runtimeSettings,
    effectiveSettings: { ...providerRuntimeDefaults(parameters), ...modelSettings, ...runtimeSettings },
    parameters,
  };
}

function parseToolSecret(row, decrypt) {
  if (!row.secretConfigurationEncrypted) return null;
  const plaintext = decrypt(row.secretConfigurationEncrypted);
  try {
    return JSON.parse(plaintext);
  } catch {
    throw new AppError(409, `Tool secret configuration is invalid for ${row.name}`, 'VOICE_TOOL_SECRET_INVALID', {
      toolId: row.id,
    });
  }
}

function tools(rows, decrypt) {
  return (rows ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    configuration: row.configuration ?? {},
    secretConfiguration: parseToolSecret(row, decrypt),
  }));
}

function integrationConfiguration(settings) {
  return {
    preCall: {
      provider: settings.preCallProvider ?? null,
      prompt: settings.preCallPrompt ?? '',
      api: {
        active: settings.preCallApiActive === true,
        url: settings.preCallApiUrl ?? '',
        method: settings.preCallApiMethod ?? null,
        headers: settings.preCallApiHeaders ?? null,
        requestBody: settings.preCallApiRequestBody ?? null,
        responseMappings: settings.preCallApiResponseMappings ?? [],
      },
    },
    postCall: {
      prompt: settings.postCallPrompt ?? '',
      messageType: settings.postCallMessageType ?? null,
      dynamicClosing: settings.postCallDynamicClosing ?? '',
      uninterruptibleReasons: settings.postCallUninterruptibleReasons ?? [],
      api: {
        active: settings.postCallEndpointDetailsActive === true,
        url: settings.postCallApiUrl ?? '',
        method: settings.postCallApiMethod ?? null,
        headers: settings.postCallApiHeaders ?? null,
      },
    },
  };
}

const sttSettingKeys = [
  'sttMode', 'sttLanguage', 'sttPunctuate', 'sttSmartFormat',
  'timeBasedInterruptionEnabled', 'wordBasedInterruptionEnabled',
  'wordInterruptionMinWords', 'wordInterruptionTriggerWords', 'interruptionPolicy',
  'sttHighVadSensitivity', 'sttVadSignals', 'sttFlushSignal',
  'sttPositiveSpeechThreshold', 'sttNegativeSpeechThreshold', 'sttMinSpeechFrames',
  'sttFirstTurnMinSpeechFrames', 'sttNegativeFramesCount', 'sttNegativeFramesWindow',
  'sttStartSpeechVolumeThreshold', 'sttInterruptMinSpeechFrames',
  'sttPreSpeechPadFrames', 'sttNumInitialIgnoredFrames',
];
const ttsSettingKeys = [
  'ttsAmbienceType', 'ttsSpeed', 'ttsStyle', 'ttsLanguage', 'ttsStability',
  'ttsSimilarityBoost', 'ttsEmotion', 'ttsVolume', 'pronunciationGroups',
];

const parameterSubquery = (providerAlias) => `COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'key', p.key, 'plainValue', p.plain_value, 'encryptedValue', p.encrypted_value, 'isSecret', p.is_secret
) ORDER BY p.key) FROM ai_provider_parameters p WHERE p.provider_id=${providerAlias}.id), '[]'::jsonb)`;

export function loadAgentRuntimeProfile(resolvedAgent, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? defaultContextRunner;
  const decrypt = dependencies.decryptCredential ?? decryptCredential;
  return contextRunner(async (client) => {
    const result = await client.query(
      `SELECT a.id, a.tenant_id, a.workspace_id, a.phone_number_id, a.name, a.description, a.goal, a.language,
          a.usage_direction, a.voice_id, a.prompt, a.welcome_message, a.temperature,
          a.interruption_sensitivity, a.silence_timeout_ms, a.inactivity_timeout_seconds, a.settings,
          sm.id stt_model_id, sm.model_key stt_model_key, sm.display_name stt_model_name,
          sm.settings stt_model_settings, sm.capabilities stt_model_capabilities,
          sp.id stt_provider_id, sp.name stt_provider_name, sp.slug stt_provider_slug, sp.base_url stt_base_url,
          ${parameterSubquery('sp')} stt_parameters,
          lm.id llm_model_id, lm.model_key llm_model_key, lm.display_name llm_model_name,
          lm.settings llm_model_settings, lm.capabilities llm_model_capabilities,
          lp.id llm_provider_id, lp.name llm_provider_name, lp.slug llm_provider_slug, lp.base_url llm_base_url,
          ${parameterSubquery('lp')} llm_parameters,
          tm.id tts_model_id, tm.model_key tts_model_key, tm.display_name tts_model_name,
          tm.settings tts_model_settings, tm.capabilities tts_model_capabilities,
          tp.id tts_provider_id, tp.name tts_provider_name, tp.slug tts_provider_slug, tp.base_url tts_base_url,
          ${parameterSubquery('tp')} tts_parameters,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', t.id, 'name', t.name, 'type', t.type, 'description', t.description,
            'configuration', t.configuration,
            'secretConfigurationEncrypted', t.secret_configuration_encrypted
          ) ORDER BY t.created_at, t.id)
            FROM agent_tools t
           WHERE t.tenant_id=a.tenant_id AND t.agent_id=a.id
             AND t.status='active' AND t.deleted_at IS NULL), '[]'::jsonb) tools,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', kb.id, 'name', kb.name, 'description', kb.description,
            'usageDirection', akb.usage_direction, 'priority', akb.priority,
            'publicationRevision', kb.publication_revision,
            'semanticReady', EXISTS (
              SELECT 1 FROM knowledge_processing_jobs j
               WHERE j.tenant_id=kb.tenant_id AND j.knowledge_base_id=kb.id
                 AND j.job_type='index' AND j.status='completed'
                 AND j.metadata->>'publicationRevision'=kb.publication_revision::text
            ), 'settings', kb.settings
          ) ORDER BY akb.priority, kb.id)
            FROM agent_knowledge_bases akb
            JOIN knowledge_bases kb
              ON kb.tenant_id=akb.tenant_id AND kb.id=akb.knowledge_base_id
           WHERE akb.tenant_id=a.tenant_id AND akb.agent_id=a.id
             AND kb.status IN ('published', 'partially_failed')
             AND kb.publication_revision>0 AND kb.deleted_at IS NULL
             AND ($4::agent_usage_direction IS NULL
               OR akb.usage_direction='both' OR akb.usage_direction=$4::agent_usage_direction)
             AND ($4::agent_usage_direction IS NULL
               OR kb.usage_direction='both' OR kb.usage_direction=$4::agent_usage_direction)
          ), '[]'::jsonb) knowledge_bases
         FROM voice_agents a
         JOIN provider_models sm ON sm.id=a.stt_model_id AND sm.status='active' AND sm.deleted_at IS NULL
         JOIN ai_providers sp ON sp.id=sm.provider_id AND sp.type='stt' AND sp.status='connected' AND sp.deleted_at IS NULL
         JOIN provider_models lm ON lm.id=a.llm_model_id AND lm.status='active' AND lm.deleted_at IS NULL
         JOIN ai_providers lp ON lp.id=lm.provider_id AND lp.type='llm' AND lp.status='connected' AND lp.deleted_at IS NULL
         JOIN provider_models tm ON tm.id=a.tts_model_id AND tm.status='active' AND tm.deleted_at IS NULL
         JOIN ai_providers tp ON tp.id=tm.provider_id AND tp.type='tts' AND tp.status='connected' AND tp.deleted_at IS NULL
        WHERE a.id=$1 AND a.tenant_id=$2 AND a.workspace_id=$3
          AND a.status='active' AND a.deleted_at IS NULL`,
      [resolvedAgent.agentId, resolvedAgent.tenantId, resolvedAgent.workspaceId, resolvedAgent.callDirection ?? null],
    );
    if (!result.rowCount) {
      throw new AppError(409, 'Agent runtime profile is no longer available', 'VOICE_RUNTIME_PROFILE_UNAVAILABLE');
    }
    const row = result.rows[0];
    const settings = row.settings ?? {};
    const sttRuntimeSettings = selectedSettings(settings, sttSettingKeys);
    const ttsRuntimeSettings = {
      ...selectedSettings(settings, ttsSettingKeys),
      voiceId: row.voice_id,
    };
    return {
      schemaVersion: 1,
      agent: {
        id: row.id,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        phoneNumberId: row.phone_number_id,
        name: row.name,
        description: row.description,
        goal: row.goal,
        language: row.language,
        usageDirection: row.usage_direction,
        callDirection: resolvedAgent.callDirection ?? null,
        voiceId: row.voice_id,
        prompt: row.prompt,
        welcomeMessage: row.welcome_message,
        temperature: Number(row.temperature),
        interruptionSensitivity: Number(row.interruption_sensitivity),
        silenceTimeoutMs: row.silence_timeout_ms,
        inactivityTimeoutSeconds: row.inactivity_timeout_seconds,
        settings,
        speech: {
          listener: sttRuntimeSettings,
          speaker: ttsRuntimeSettings,
          interaction: {
            greetingMode: settings.greetingMode ?? null,
            cachePolicy: settings.cachePolicy ?? null,
            contextId: settings.contextId ?? null,
            silentMessage: settings.silentMessage ?? '',
          },
        },
      },
      providers: {
        stt: provider(row, 'stt', decrypt, sttRuntimeSettings),
        llm: provider(row, 'llm', decrypt),
        tts: provider(row, 'tts', decrypt, ttsRuntimeSettings),
      },
      knowledgeBases: row.knowledge_bases ?? [],
      tools: tools(row.tools, decrypt),
      integrations: integrationConfiguration(settings),
    };
  });
}
