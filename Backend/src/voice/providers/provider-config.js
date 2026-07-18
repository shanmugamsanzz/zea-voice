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

function provider(row, prefix, decrypt) {
  return {
    providerId: row[`${prefix}_provider_id`],
    providerName: row[`${prefix}_provider_name`],
    baseUrl: row[`${prefix}_base_url`],
    modelId: row[`${prefix}_model_id`],
    modelKey: row[`${prefix}_model_key`],
    modelName: row[`${prefix}_model_name`],
    modelSettings: row[`${prefix}_model_settings`] ?? {},
    modelCapabilities: row[`${prefix}_model_capabilities`] ?? {},
    parameters: parameterMap(row[`${prefix}_parameters`], decrypt),
  };
}

const parameterSubquery = (providerAlias) => `COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'key', p.key, 'plainValue', p.plain_value, 'encryptedValue', p.encrypted_value, 'isSecret', p.is_secret
) ORDER BY p.key) FROM ai_provider_parameters p WHERE p.provider_id=${providerAlias}.id), '[]'::jsonb)`;

export function loadAgentRuntimeProfile(resolvedAgent, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? defaultContextRunner;
  const decrypt = dependencies.decryptCredential ?? decryptCredential;
  return contextRunner(async (client) => {
    const result = await client.query(
      `SELECT a.id, a.tenant_id, a.workspace_id, a.name, a.description, a.goal, a.language,
          a.usage_direction, a.prompt, a.welcome_message, a.temperature,
          a.interruption_sensitivity, a.silence_timeout_ms, a.inactivity_timeout_seconds, a.settings,
          sm.id stt_model_id, sm.model_key stt_model_key, sm.display_name stt_model_name,
          sm.settings stt_model_settings, sm.capabilities stt_model_capabilities,
          sp.id stt_provider_id, sp.name stt_provider_name, sp.base_url stt_base_url,
          ${parameterSubquery('sp')} stt_parameters,
          lm.id llm_model_id, lm.model_key llm_model_key, lm.display_name llm_model_name,
          lm.settings llm_model_settings, lm.capabilities llm_model_capabilities,
          lp.id llm_provider_id, lp.name llm_provider_name, lp.base_url llm_base_url,
          ${parameterSubquery('lp')} llm_parameters,
          tm.id tts_model_id, tm.model_key tts_model_key, tm.display_name tts_model_name,
          tm.settings tts_model_settings, tm.capabilities tts_model_capabilities,
          tp.id tts_provider_id, tp.name tts_provider_name, tp.base_url tts_base_url,
          ${parameterSubquery('tp')} tts_parameters
         FROM voice_agents a
         JOIN provider_models sm ON sm.id=a.stt_model_id AND sm.status='active' AND sm.deleted_at IS NULL
         JOIN ai_providers sp ON sp.id=sm.provider_id AND sp.type='stt' AND sp.status='connected' AND sp.deleted_at IS NULL
         JOIN provider_models lm ON lm.id=a.llm_model_id AND lm.status='active' AND lm.deleted_at IS NULL
         JOIN ai_providers lp ON lp.id=lm.provider_id AND lp.type='llm' AND lp.status='connected' AND lp.deleted_at IS NULL
         JOIN provider_models tm ON tm.id=a.tts_model_id AND tm.status='active' AND tm.deleted_at IS NULL
         JOIN ai_providers tp ON tp.id=tm.provider_id AND tp.type='tts' AND tp.status='connected' AND tp.deleted_at IS NULL
        WHERE a.id=$1 AND a.tenant_id=$2 AND a.workspace_id=$3
          AND a.status='active' AND a.deleted_at IS NULL`,
      [resolvedAgent.agentId, resolvedAgent.tenantId, resolvedAgent.workspaceId],
    );
    if (!result.rowCount) {
      throw new AppError(409, 'Agent runtime profile is no longer available', 'VOICE_RUNTIME_PROFILE_UNAVAILABLE');
    }
    const row = result.rows[0];
    return {
      agent: {
        id: row.id,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        name: row.name,
        description: row.description,
        goal: row.goal,
        language: row.language,
        usageDirection: row.usage_direction,
        prompt: row.prompt,
        welcomeMessage: row.welcome_message,
        temperature: Number(row.temperature),
        interruptionSensitivity: Number(row.interruption_sensitivity),
        silenceTimeoutMs: row.silence_timeout_ms,
        inactivityTimeoutSeconds: row.inactivity_timeout_seconds,
        settings: row.settings ?? {},
      },
      providers: {
        stt: provider(row, 'stt', decrypt),
        llm: provider(row, 'llm', decrypt),
        tts: provider(row, 'tts', decrypt),
      },
    };
  });
}
