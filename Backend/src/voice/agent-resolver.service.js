import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { isRuntimeConnectionLiveEligible } from '../providers/runtime-connection-types.js';

const defaultContextRunner = (operation) => withPlatformAdminContext(null, operation);

function model(row, prefix) {
  return {
    modelId: row[`${prefix}_model_id`],
    modelKey: row[`${prefix}_model_key`],
    modelName: row[`${prefix}_model_name`],
    providerId: row[`${prefix}_provider_id`],
    providerName: row[`${prefix}_provider_name`],
  };
}

export function resolvePhoneNumberAgent(call, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? defaultContextRunner;
  return contextRunner(async (client) => {
    const platformNumber = call.direction === 'outbound' ? call.from : call.to;
    const assignment = await client.query(
      `SELECT pa.tenant_id,tl.max_total_concurrency,tl.max_inbound_queue_size,tl.max_inbound_wait_seconds,
          COALESCE(ts.recording_enabled,true) recording_enabled
         FROM phone_numbers pn
         JOIN phone_number_assignments pa ON pa.phone_number_id=pn.id AND pa.released_at IS NULL
         LEFT JOIN tenant_limits tl ON tl.tenant_id=pa.tenant_id
         LEFT JOIN tenant_settings ts ON ts.tenant_id=pa.tenant_id
        WHERE pn.id=$1 AND pn.e164=$2 AND pn.status='active' AND pn.deleted_at IS NULL`,
      [call.phoneNumberId, platformNumber],
    );
    if (!assignment.rowCount) {
      throw new AppError(404, 'Called number is not assigned to a company', 'VOICE_PHONE_NOT_ASSIGNED');
    }
    if (!Number.isInteger(Number(assignment.rows[0].max_total_concurrency))
      || Number(assignment.rows[0].max_total_concurrency) < 1) {
      throw new AppError(409, 'Company live-call concurrency is not configured.', 'COMPANY_CONCURRENCY_NOT_CONFIGURED');
    }

    let followUpAgentId=null;
    if(call.direction==='outbound' && call.capacityReservationId){
      const selected=await client.query(`SELECT r.agent_id FROM agent_phone_test_requests r JOIN scheduled_follow_up_tasks t
        ON t.id=r.follow_up_task_id AND t.tenant_id=r.tenant_id AND t.workspace_id=r.workspace_id
        WHERE r.id=$1 AND r.tenant_id=$2 AND r.phone=$3 AND r.status IN ('dispatching','initiated')`,
        [call.capacityReservationId,assignment.rows[0].tenant_id,call.to]);
      followUpAgentId=selected.rows[0]?.agent_id??null;
    }
    const agentResult = await client.query(
      `SELECT a.id, a.tenant_id, a.workspace_id, a.name, a.language, a.usage_direction,
          a.stt_model_id, a.llm_model_id, a.tts_model_id
         FROM voice_agents a
        WHERE a.phone_number_id=$1 AND a.tenant_id=$2
          AND a.status='active' AND a.deleted_at IS NULL ${followUpAgentId?'AND a.id=$3':''}`,
      [call.phoneNumberId, assignment.rows[0].tenant_id,...(followUpAgentId?[followUpAgentId]:[])],
    );
    if (!agentResult.rowCount) {
      throw new AppError(404, 'No active voice agent is mapped to the called number', 'VOICE_AGENT_NOT_FOUND');
    }
    const agent = agentResult.rows[0];
    if (agent.usage_direction !== 'both' && agent.usage_direction !== call.direction) {
      throw new AppError(409, 'Voice agent does not support this call direction', 'VOICE_AGENT_DIRECTION_MISMATCH');
    }

    const models = await client.query(
      `SELECT
          stt.id stt_model_id, stt.model_key stt_model_key, stt.display_name stt_model_name,
          sttp.id stt_provider_id, sttp.name stt_provider_name, sttp.runtime_connection_type stt_runtime_connection_type,
          llm.id llm_model_id, llm.model_key llm_model_key, llm.display_name llm_model_name,
          llmp.id llm_provider_id, llmp.name llm_provider_name, llmp.runtime_connection_type llm_runtime_connection_type,
          tts.id tts_model_id, tts.model_key tts_model_key, tts.display_name tts_model_name,
          ttsp.id tts_provider_id, ttsp.name tts_provider_name, ttsp.runtime_connection_type tts_runtime_connection_type
         FROM provider_models stt JOIN ai_providers sttp ON sttp.id=stt.provider_id
         JOIN provider_models llm ON llm.id=$2 JOIN ai_providers llmp ON llmp.id=llm.provider_id
         JOIN provider_models tts ON tts.id=$3 JOIN ai_providers ttsp ON ttsp.id=tts.provider_id
        WHERE stt.id=$1
          AND stt.status='active' AND stt.deleted_at IS NULL
          AND llm.status='active' AND llm.deleted_at IS NULL
          AND tts.status='active' AND tts.deleted_at IS NULL
          AND sttp.type='stt' AND sttp.status='connected' AND sttp.deleted_at IS NULL
          AND llmp.type='llm' AND llmp.status='connected' AND llmp.deleted_at IS NULL
          AND ttsp.type='tts' AND ttsp.status='connected' AND ttsp.deleted_at IS NULL`,
      [agent.stt_model_id, agent.llm_model_id, agent.tts_model_id],
    );
    if (!models.rowCount) {
      throw new AppError(409, 'Agent STT, LLM, or TTS configuration is unavailable', 'VOICE_AGENT_MODEL_UNAVAILABLE');
    }
    const configured = models.rows[0];
    for (const type of ['stt', 'llm', 'tts']) {
      if (!isRuntimeConnectionLiveEligible(type, configured[`${type}_runtime_connection_type`], 'connected')) {
        throw new AppError(409, `Agent ${type.toUpperCase()} model is configuration only and cannot be used in a live call`,
          'VOICE_AGENT_MODEL_CONFIGURATION_ONLY', { type, runtimeConnectionType: configured[`${type}_runtime_connection_type`] });
      }
    }
    return {
      tenantId: agent.tenant_id,
      workspaceId: agent.workspace_id,
      agentId: agent.id,
      agentName: agent.name,
      language: agent.language,
      callDirection: call.direction,
      usageDirection: agent.usage_direction,
      concurrencyLimit: Number(assignment.rows[0].max_total_concurrency),
      inboundQueueMaxSize: assignment.rows[0].max_inbound_queue_size,
      inboundQueueMaxWaitSeconds: assignment.rows[0].max_inbound_wait_seconds,
      recordingEnabled: Boolean(assignment.rows[0].recording_enabled),
      stt: model(configured, 'stt'),
      llm: model(configured, 'llm'),
      tts: model(configured, 'tts'),
    };
  });
}
