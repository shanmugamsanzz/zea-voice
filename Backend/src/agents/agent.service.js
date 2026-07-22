import { withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { providerAdapterRegistry } from '../voice/providers/registry.js';
import { registerImplementedProviderAdapters } from '../voice/providers/defaults.js';

const select = `SELECT a.*, pn.e164 AS phone_number,
  sp.name AS stt_provider_name, sm.display_name AS stt_model_name,
  lp.name AS llm_provider_name, lm.display_name AS llm_model_name,
  tp.name AS tts_provider_name, tm.display_name AS tts_model_name,
  stats.total_calls, stats.average_duration_seconds, stats.success_rate
  FROM voice_agents a
  LEFT JOIN phone_numbers pn ON pn.id=a.phone_number_id
  JOIN provider_models sm ON sm.id=a.stt_model_id JOIN ai_providers sp ON sp.id=sm.provider_id
  JOIN provider_models lm ON lm.id=a.llm_model_id JOIN ai_providers lp ON lp.id=lm.provider_id
  JOIN provider_models tm ON tm.id=a.tts_model_id JOIN ai_providers tp ON tp.id=tm.provider_id
  LEFT JOIN LATERAL (SELECT count(*)::int AS total_calls,
    COALESCE(avg(c.duration_seconds),0) AS average_duration_seconds,
    CASE WHEN count(*)=0 THEN 0 ELSE round((count(*) FILTER (WHERE c.status='completed')::numeric/count(*))*100,2) END AS success_rate
    FROM call_sessions c WHERE c.tenant_id=a.tenant_id AND c.agent_id=a.id) stats ON true
  WHERE a.tenant_id=$1 AND a.deleted_at IS NULL`;
function map(row) { return { id: row.id, tenantId: row.tenant_id, workspaceId: row.workspace_id, name: row.name,
  description: row.description, goal: row.goal, language: row.language, usageDirection: row.usage_direction, status: row.status,
  phoneNumberId: row.phone_number_id, phoneNumber: row.phone_number,
  stt: { modelId: row.stt_model_id, providerName: row.stt_provider_name, modelName: row.stt_model_name },
  llm: { modelId: row.llm_model_id, providerName: row.llm_provider_name, modelName: row.llm_model_name },
  tts: { modelId: row.tts_model_id, providerName: row.tts_provider_name, modelName: row.tts_model_name },
  voiceId: row.voice_id, prompt: row.prompt, welcomeMessage: row.welcome_message,
  temperature: Number(row.temperature), interruptionSensitivity: Number(row.interruption_sensitivity),
  silenceTimeoutMs: row.silence_timeout_ms, inactivityTimeoutSeconds: row.inactivity_timeout_seconds,
  settings: row.settings,
  metrics: { totalCalls: Number(row.total_calls ?? 0), averageDurationSeconds: Number(row.average_duration_seconds ?? 0), successRate: Number(row.success_rate ?? 0) },
  createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at } }
async function agentRow(client, tenantId, id) { const result = await client.query(`${select} AND a.id=$2`, [tenantId, id]);
  if (!result.rowCount) throw new AppError(404, 'Voice agent was not found', 'AGENT_NOT_FOUND'); return result.rows[0]; }
export async function validateAgentRuntimeModels(client, input, registry = providerAdapterRegistry) {
  registerImplementedProviderAdapters(registry);
  const expected = [['sttModelId', 'stt'], ['llmModelId', 'llm'], ['ttsModelId', 'tts']];
  for (const [field, type] of expected) {
    const result = await client.query(`SELECT m.id model_id,m.model_key,m.settings model_settings,
      m.capabilities model_capabilities,p.id provider_id,p.name provider_name,p.slug provider_slug,
      COALESCE((SELECT jsonb_object_agg(x.key,x.plain_value)
        FROM ai_provider_parameters x
        WHERE x.provider_id=p.id AND x.plain_value IS NOT NULL AND x.is_secret=false
          AND lower(x.key) !~ '(api[_.-]?key|token|secret|password|credential|auth)'), '{}'::jsonb) provider_settings
      FROM provider_models m JOIN ai_providers p ON p.id=m.provider_id
      WHERE m.id=$1 AND m.status='active' AND m.deleted_at IS NULL AND p.type=$2::ai_provider_type
      AND p.status='connected' AND p.deleted_at IS NULL`, [input[field], type]);
    if (!result.rowCount) throw new AppError(400, `Selected ${type.toUpperCase()} model is unavailable`, 'AGENT_MODEL_UNAVAILABLE', { field });
    const row = result.rows[0];
    try {
      registry.resolve(type, {
        providerId: row.provider_id,
        providerName: row.provider_name,
        providerSlug: row.provider_slug,
        modelId: row.model_id,
        modelKey: row.model_key,
        modelSettings: row.model_settings ?? {},
        modelCapabilities: row.model_capabilities ?? {},
        effectiveSettings: { ...(row.provider_settings ?? {}), ...(row.model_settings ?? {}) },
      });
    } catch (error) {
      throw new AppError(400,
        `Selected ${type.toUpperCase()} model cannot run in the voice engine: ${error.message}`,
        'AGENT_MODEL_RUNTIME_INCOMPATIBLE',
        { field, providerId: row.provider_id, modelId: row.model_id, reason: error.code },
      );
    }
  }
}
async function validatePhone(client, tenantId, phoneNumberId) {
  if (!phoneNumberId) return;
  const result = await client.query(`SELECT 1 FROM phone_numbers pn JOIN phone_number_assignments pa ON pa.phone_number_id=pn.id
    WHERE pn.id=$1 AND pn.status='active' AND pn.deleted_at IS NULL AND pn.assigned_tenant_id=$2
      AND pa.tenant_id=$2 AND pa.released_at IS NULL`, [phoneNumberId, tenantId]);
  if (!result.rowCount) throw new AppError(400, 'Phone number is not actively assigned to this company', 'AGENT_PHONE_UNAVAILABLE');
}
export function listAgents(auth, filters) { return withTenantContext(auth, async (client) => {
  const values = [auth.tenantId, filters.search ?? null, filters.status ?? null];
  const where = ` AND ($2::text IS NULL OR a.name ILIKE '%'||$2||'%' OR a.description ILIKE '%'||$2||'%') AND ($3::voice_agent_status IS NULL OR a.status=$3)`;
  const total = await client.query(`SELECT count(*)::int total FROM voice_agents a WHERE a.tenant_id=$1 AND a.deleted_at IS NULL ${where}`, values);
  const result = await client.query(`${select} ${where} ORDER BY a.created_at DESC LIMIT $4 OFFSET $5`, [...values, filters.pageSize, (filters.page-1)*filters.pageSize]);
  return { items: result.rows.map(map), pagination: { page: filters.page, pageSize: filters.pageSize, total: total.rows[0].total,
    totalPages: Math.ceil(total.rows[0].total/filters.pageSize) } };
}); }
export function getAgent(auth, id) { return withTenantContext(auth, async (client) => map(await agentRow(client, auth.tenantId, id))); }
export function createAgent(auth, input) { return withTenantContext(auth, async (client) => {
  const limit = await client.query('SELECT max_agents FROM tenant_limits WHERE tenant_id=$1 FOR UPDATE', [auth.tenantId]);
  const agentCount = await client.query(`SELECT count(*)::int AS count FROM voice_agents
    WHERE tenant_id=$1 AND deleted_at IS NULL AND status<>'archived'`, [auth.tenantId]);
  if (!limit.rowCount || agentCount.rows[0].count >= limit.rows[0].max_agents) throw new AppError(409, 'The company agent limit has been reached', 'AGENT_LIMIT_REACHED');
  await withPlatformAdminContext(auth.userId, (platformClient) => validateAgentRuntimeModels(platformClient, input));
  await validatePhone(client, auth.tenantId, input.phoneNumberId);
  try {
    const created = (await client.query(`INSERT INTO voice_agents (tenant_id,workspace_id,name,description,goal,language,usage_direction,status,phone_number_id,
      stt_model_id,llm_model_id,tts_model_id,voice_id,prompt,welcome_message,temperature,interruption_sensitivity,
      silence_timeout_ms,inactivity_timeout_seconds,settings,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$21) RETURNING id`,
    [auth.tenantId,auth.workspaceId,input.name,input.description??null,input.goal??null,input.language,input.usageDirection,input.status,input.phoneNumberId??null,
      input.sttModelId,input.llmModelId,input.ttsModelId,input.voiceId,input.prompt,input.welcomeMessage??null,input.temperature,
      input.interruptionSensitivity,input.silenceTimeoutMs,input.inactivityTimeoutSeconds,JSON.stringify(input.settings),auth.userId])).rows[0];
    await client.query(`INSERT INTO audit_logs (tenant_id,workspace_id,actor_user_id,actor_type,action,entity_type,entity_id,after_data)
      VALUES ($1,$2,$3,'user','VOICE_AGENT_CREATED','voice_agent',$4,$5::jsonb)`, [auth.tenantId,auth.workspaceId,auth.userId,created.id,JSON.stringify({name:input.name,status:input.status})]);
    return map(await agentRow(client, auth.tenantId, created.id));
  } catch (error) { if (error.code==='23505') throw new AppError(409, 'Agent name or phone mapping already exists', 'AGENT_CONFLICT'); throw error; }
}); }
export function updateAgent(auth, id, input) { return withTenantContext(auth, async (client) => {
  const before = await agentRow(client, auth.tenantId, id);
  const value = { name: input.name??before.name, description: Object.hasOwn(input,'description')?input.description:before.description,
    goal:Object.hasOwn(input,'goal')?input.goal:before.goal, language:input.language??before.language,
    usageDirection:input.usageDirection??before.usage_direction, status:input.status??before.status,
    phoneNumberId:Object.hasOwn(input,'phoneNumberId')?input.phoneNumberId:before.phone_number_id,
    sttModelId:input.sttModelId??before.stt_model_id,llmModelId:input.llmModelId??before.llm_model_id,ttsModelId:input.ttsModelId??before.tts_model_id,
    voiceId:input.voiceId??before.voice_id,prompt:input.prompt??before.prompt,welcomeMessage:Object.hasOwn(input,'welcomeMessage')?input.welcomeMessage:before.welcome_message,
    temperature:input.temperature??Number(before.temperature),interruptionSensitivity:input.interruptionSensitivity??Number(before.interruption_sensitivity),
    silenceTimeoutMs:input.silenceTimeoutMs??before.silence_timeout_ms,inactivityTimeoutSeconds:input.inactivityTimeoutSeconds??before.inactivity_timeout_seconds,
    settings:input.settings??before.settings };
  await withPlatformAdminContext(auth.userId, (platformClient) => validateAgentRuntimeModels(platformClient, value));
  await validatePhone(client,auth.tenantId,value.phoneNumberId);
  try { await client.query(`UPDATE voice_agents SET name=$3,description=$4,goal=$5,language=$6,usage_direction=$7,status=$8,phone_number_id=$9,
    stt_model_id=$10,llm_model_id=$11,tts_model_id=$12,voice_id=$13,prompt=$14,welcome_message=$15,temperature=$16,
    interruption_sensitivity=$17,silence_timeout_ms=$18,inactivity_timeout_seconds=$19,settings=$20::jsonb,updated_by=$21
    WHERE tenant_id=$1 AND id=$2`, [auth.tenantId,id,value.name,value.description,value.goal,value.language,value.usageDirection,value.status,value.phoneNumberId,
      value.sttModelId,value.llmModelId,value.ttsModelId,value.voiceId,value.prompt,value.welcomeMessage,value.temperature,value.interruptionSensitivity,
      value.silenceTimeoutMs,value.inactivityTimeoutSeconds,JSON.stringify(value.settings),auth.userId]);
  } catch(error) { if(error.code==='23505') throw new AppError(409,'Agent name or phone mapping already exists','AGENT_CONFLICT'); throw error; }
  await client.query(`INSERT INTO audit_logs (tenant_id,workspace_id,actor_user_id,actor_type,action,entity_type,entity_id,before_data,after_data)
    VALUES ($1,$2,$3,'user','VOICE_AGENT_UPDATED','voice_agent',$4,$5::jsonb,$6::jsonb)`, [auth.tenantId,auth.workspaceId,auth.userId,id,
      JSON.stringify({name:before.name,status:before.status}),JSON.stringify({name:value.name,status:value.status})]);
  return map(await agentRow(client,auth.tenantId,id));
}); }
export function archiveAgent(auth,id) { return withTenantContext(auth, async(client)=>{ await agentRow(client,auth.tenantId,id);
  await client.query(`UPDATE voice_agents SET status='archived',deleted_at=now(),updated_by=$3 WHERE tenant_id=$1 AND id=$2`,[auth.tenantId,id,auth.userId]);
  await client.query(`INSERT INTO audit_logs (tenant_id,workspace_id,actor_user_id,actor_type,action,entity_type,entity_id)
    VALUES ($1,$2,$3,'user','VOICE_AGENT_DELETED','voice_agent',$4)`,[auth.tenantId,auth.workspaceId,auth.userId,id]); return {id,deleted:true}; }); }
