import { withPlatformAdminContext } from '../../infrastructure/database-context.js';
import { AppError } from '../../middleware/errors.js';
import { decryptCredential } from '../../security/credential-crypto.js';

function map(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    callSessionId: row.call_session_id,
    agentId: row.agent_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    status: row.status,
    instructions: row.instructions,
    includeTranscriptInWebhook: row.include_transcript_in_webhook,
    includeSummaryInWebhook: row.include_summary_in_webhook,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    bullmqJobId: row.bullmq_job_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    summary: row.summary_text ? {
      summary: row.summary_text,
      outcome: row.outcome,
      customerIntent: row.customer_intent,
      sentiment: row.sentiment,
      collectedData: row.collected_data ?? {},
      followUpRequired: row.follow_up_required,
      followUpReason: row.follow_up_reason,
    } : null,
    usage: row.usage ?? {},
    webhookDelivery: row.webhook_delivery ?? {},
    providerRequestId: row.provider_request_id,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    processingStartedAt: row.processing_started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    queuedAt: row.queued_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function providerParameters(rows, decrypt) {
  return Object.fromEntries((rows ?? []).map((parameter) => [
    parameter.key,
    parameter.isSecret ? decrypt(parameter.encryptedValue) : parameter.plainValue,
  ]));
}

function processingJob(row, decrypt) {
  const parameters = providerParameters(row.provider_parameters, decrypt);
  const modelSettings = row.model_settings ?? {};
  return {
    ...map(row),
    call: {
      providerCallId: row.provider_call_id,
      direction: row.direction,
      status: row.call_status,
      reason: row.call_reason,
      startedAt: row.started_at,
      answeredAt: row.answered_at,
      endedAt: row.ended_at,
      durationSeconds: Number(row.call_duration_seconds ?? 0),
    },
    agent: {
      name: row.agent_name,
      goal: row.agent_goal,
      language: row.agent_language,
      settings: row.agent_settings ?? {},
    },
    transcript: row.transcript ?? [],
    providerUsage: {
      providers: row.provider_usage ?? [],
      totals: (row.provider_usage ?? []).reduce((total, usage) => {
        for (const field of ['requests', 'inputTokens', 'outputTokens', 'totalTokens', 'audioInputMs',
          'audioOutputMs', 'characters', 'durationMs', 'cost']) {
          total[field] += Number(usage[field] ?? 0);
        }
        return total;
      }, {
        requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, audioInputMs: 0,
        audioOutputMs: 0, characters: 0, durationMs: 0, cost: 0,
      }),
    },
    provider: {
      providerId: row.provider_id,
      providerName: row.provider_name,
      providerSlug: row.provider_slug,
      baseUrl: row.provider_base_url,
      modelId: row.model_id,
      modelKey: row.model_key,
      modelName: row.model_name,
      modelSettings,
      modelCapabilities: row.model_capabilities ?? {},
      effectiveSettings: {
        ...Object.fromEntries(Object.entries(parameters).filter(([key]) => !/(api[_.-]?key|token|secret|password|credential|auth)/i.test(key))),
        ...modelSettings,
      },
      parameters,
    },
  };
}

export function createQueuedPostCallSummaryJob(callSessionId, dependencies = {}) {
  // This is an internal worker path with no signed-in user. Auth-service context is
  // intentionally restricted by RLS and cannot see tenant agent/model settings.
  // Platform context is required to resolve the call, while the SQL still binds every
  // selected resource to the call's own tenant.
  const contextRunner = dependencies.contextRunner
    ?? ((operation) => withPlatformAdminContext(null, operation));
  const maxAttempts = dependencies.maxAttempts ?? 3;
  return contextRunner(async (client) => {
    const result = await client.query(
      `WITH candidate AS (
         SELECT c.tenant_id,c.workspace_id,c.id call_session_id,c.agent_id,
                p.id provider_id,m.id model_id,
                trim(a.settings->>'postCallSummaryInstructions') instructions,
                CASE WHEN a.settings->>'postCallIncludeTranscript' IN ('true','false')
                  THEN (a.settings->>'postCallIncludeTranscript')::boolean ELSE true END include_transcript,
                CASE WHEN a.settings->>'postCallIncludeSummary' IN ('true','false')
                  THEN (a.settings->>'postCallIncludeSummary')::boolean ELSE true END include_summary
           FROM call_sessions c
           JOIN voice_agents a ON a.tenant_id=c.tenant_id AND a.id=c.agent_id
             AND a.deleted_at IS NULL
           JOIN provider_models m ON m.id::text=a.settings->>'postCallSummaryModelId'
             AND m.status='active' AND m.deleted_at IS NULL
           JOIN ai_providers p ON p.id=m.provider_id AND p.type='llm'
             AND p.status='connected' AND p.deleted_at IS NULL
          WHERE c.id=$1 AND c.ended_at IS NOT NULL
            AND a.settings->>'postCallSummaryEnabled'='true'
            AND length(trim(a.settings->>'postCallSummaryInstructions')) BETWEEN 1 AND 20000
       ), inserted AS (
         INSERT INTO call_ai_summaries
           (tenant_id,workspace_id,call_session_id,agent_id,provider_id,model_id,
            instructions,include_transcript_in_webhook,include_summary_in_webhook,max_attempts)
         SELECT tenant_id,workspace_id,call_session_id,agent_id,provider_id,model_id,
                instructions,include_transcript,include_summary,$2
           FROM candidate
         ON CONFLICT (call_session_id) DO NOTHING
         RETURNING *,true AS newly_created
       )
       SELECT * FROM inserted
       UNION ALL
       SELECT existing.*,false AS newly_created
         FROM call_ai_summaries existing
         JOIN candidate ON candidate.call_session_id=existing.call_session_id
        WHERE NOT EXISTS (SELECT 1 FROM inserted)
       LIMIT 1`,
      [callSessionId, maxAttempts],
    );
    if (result.rowCount) return { ...map(result.rows[0]), newlyCreated: result.rows[0].newly_created };

    const call = await client.query('SELECT ended_at FROM call_sessions WHERE id=$1', [callSessionId]);
    if (!call.rowCount) throw new AppError(404, 'Call session was not found', 'POSTCALL_SUMMARY_CALL_NOT_FOUND');
    if (!call.rows[0].ended_at) throw new AppError(409, 'Call must end before summarization can be queued', 'POSTCALL_SUMMARY_CALL_ACTIVE');
    return null;
  });
}

export function attachPostCallSummaryQueueJob(summaryJobId, bullmqJobId, dependencies = {}) {
  const contextRunner = dependencies.contextRunner
    ?? ((operation) => withPlatformAdminContext(null, operation));
  return contextRunner(async (client) => {
    const result = await client.query(
      `UPDATE call_ai_summaries
          SET bullmq_job_id=COALESCE(bullmq_job_id,$2),
              error_code=CASE WHEN status='queued' THEN NULL ELSE error_code END,
              error_message=CASE WHEN status='queued' THEN NULL ELSE error_message END
        WHERE id=$1
        RETURNING *`,
      [summaryJobId, String(bullmqJobId)],
    );
    if (!result.rowCount) throw new AppError(404, 'Summary job was not found', 'POSTCALL_SUMMARY_JOB_NOT_FOUND');
    return map(result.rows[0]);
  });
}

export function recordPostCallSummaryQueueFailure(summaryJobId, error, dependencies = {}) {
  const contextRunner = dependencies.contextRunner
    ?? ((operation) => withPlatformAdminContext(null, operation));
  return contextRunner((client) => client.query(
    `UPDATE call_ai_summaries
        SET bullmq_job_id=NULL,error_code='QUEUE_UNAVAILABLE',error_message=$2
      WHERE id=$1 AND status='queued'`,
    [summaryJobId, String(error?.message ?? error ?? 'Queue unavailable').slice(0, 2000)],
  ));
}

export function listRecoverablePostCallSummaryJobs(dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withPlatformAdminContext;
  return contextRunner(null, async (client) => {
    const result = await client.query(
      `SELECT * FROM call_ai_summaries
        WHERE status='queued' AND bullmq_job_id IS NULL AND attempt_count<max_attempts
        ORDER BY queued_at,created_at LIMIT $1`,
      [dependencies.limit ?? 1000],
    );
    return result.rows.map(map);
  });
}

export function claimPostCallSummaryJob(summaryJobId, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withPlatformAdminContext;
  const decrypt = dependencies.decryptCredential ?? decryptCredential;
  return contextRunner(null, async (client) => {
    const selected = await client.query('SELECT * FROM call_ai_summaries WHERE id=$1 FOR UPDATE', [summaryJobId]);
    if (!selected.rowCount) throw new AppError(404, 'Post-Call summary job was not found', 'POSTCALL_SUMMARY_JOB_NOT_FOUND');
    const current = selected.rows[0];
    if (['completed', 'skipped'].includes(current.status)) {
      return { claimed: false, reason: 'already_finalized', job: map(current) };
    }
    if (current.status === 'failed' || Number(current.attempt_count) >= Number(current.max_attempts)) {
      return { claimed: false, reason: 'attempts_exhausted', job: map(current) };
    }
    const claimed = (await client.query(
      `UPDATE call_ai_summaries
          SET status='processing',attempt_count=attempt_count+1,
              processing_started_at=now(),failed_at=NULL,error_code=NULL,error_message=NULL
        WHERE id=$1 AND status IN ('queued','processing') AND attempt_count<max_attempts
        RETURNING *`,
      [summaryJobId],
    )).rows[0];
    if (!claimed) return { claimed: false, reason: 'not_claimable', job: map(current) };

    const details = await client.query(
      `SELECT s.*,c.provider_call_id,c.direction,c.status call_status,
              c.provider_metadata->'voiceRuntime'->>'reason' call_reason,
              c.started_at,c.answered_at,c.ended_at,c.duration_seconds call_duration_seconds,
              c.from_number,c.to_number,
              a.name agent_name,a.goal agent_goal,a.language agent_language,a.settings agent_settings,
              p.name provider_name,p.slug provider_slug,p.base_url provider_base_url,
              m.model_key,m.display_name model_name,m.settings model_settings,m.capabilities model_capabilities,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'key',x.key,'plainValue',x.plain_value,'encryptedValue',x.encrypted_value,'isSecret',x.is_secret
              ) ORDER BY x.key) FROM ai_provider_parameters x WHERE x.provider_id=p.id),'[]'::jsonb) provider_parameters,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'sequenceNumber',t.sequence_number,
                'role',CASE WHEN t.speaker::text='agent' THEN 'assistant'
                            WHEN t.speaker::text='system' THEN 'system' ELSE 'user' END,
                'content',t.text,'sources',t.sources,'createdAt',t.created_at
              ) ORDER BY t.sequence_number)
                FROM call_transcript_entries t
               WHERE t.call_session_id=s.call_session_id AND t.tenant_id=s.tenant_id AND t.is_final=true),'[]'::jsonb) transcript
              ,COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'kind',u.provider_kind,'providerId',u.provider_id,'providerName',u.provider_name,
                'modelId',u.model_id,'model',u.model_key,'requests',u.request_count,
                'inputTokens',u.input_tokens,'outputTokens',u.output_tokens,'totalTokens',u.total_tokens,
                'audioInputMs',u.audio_input_ms,'audioOutputMs',u.audio_output_ms,
                'characters',u.character_count,'durationMs',u.duration_ms,'cost',u.cost,
                'currency',u.currency,'events',u.raw_usage
              ) ORDER BY u.provider_kind)
                FROM call_provider_usage u
               WHERE u.call_session_id=s.call_session_id AND u.tenant_id=s.tenant_id),'[]'::jsonb) provider_usage
         FROM call_ai_summaries s
         JOIN call_sessions c ON c.id=s.call_session_id AND c.tenant_id=s.tenant_id
         JOIN voice_agents a ON a.id=s.agent_id AND a.tenant_id=s.tenant_id
         JOIN provider_models m ON m.id=s.model_id AND m.status='active' AND m.deleted_at IS NULL
         JOIN ai_providers p ON p.id=s.provider_id AND p.id=m.provider_id
           AND p.type='llm' AND p.status='connected' AND p.deleted_at IS NULL
        WHERE s.id=$1`,
      [summaryJobId],
    );
    if (!details.rowCount) {
      const failed = await client.query(
        `UPDATE call_ai_summaries
            SET status='failed',error_code='POSTCALL_SUMMARY_MODEL_UNAVAILABLE',
                error_message='Selected summary LLM is no longer available',failed_at=now()
          WHERE id=$1 AND status='processing' RETURNING *`,
        [summaryJobId],
      );
      return { claimed: false, reason: 'model_unavailable', job: map(failed.rows[0]) };
    }
    try {
      return { claimed: true, reason: 'processing', job: processingJob(details.rows[0], decrypt) };
    } catch (error) {
      const failed = await client.query(
        `UPDATE call_ai_summaries
            SET status='failed',error_code=$2,error_message=$3,failed_at=now()
          WHERE id=$1 AND status='processing' RETURNING *`,
        [summaryJobId, String(error?.code ?? 'POSTCALL_SUMMARY_CREDENTIALS_INVALID').slice(0, 160),
          String(error?.message ?? 'Summary provider credentials are invalid').slice(0, 2000)],
      );
      return { claimed: false, reason: 'credentials_invalid', job: map(failed.rows[0]) };
    }
  });
}

export function recordPostCallSummaryWebhookDelivery(summaryJobId, delivery, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withPlatformAdminContext;
  return contextRunner(null, async (client) => {
    const updated = await client.query(
      `UPDATE call_ai_summaries SET webhook_delivery=$2::jsonb WHERE id=$1 RETURNING *`,
      [summaryJobId, JSON.stringify(delivery ?? {})],
    );
    if (!updated.rowCount) throw new AppError(404, 'Post-Call summary job was not found', 'POSTCALL_SUMMARY_JOB_NOT_FOUND');
    await client.query(
      `UPDATE call_sessions c
          SET provider_metadata=jsonb_set(COALESCE(provider_metadata,'{}'::jsonb),
            '{voiceRuntime,postCall}',$2::jsonb,true)
         FROM call_ai_summaries s
        WHERE s.id=$1 AND c.id=s.call_session_id AND c.tenant_id=s.tenant_id`,
      [summaryJobId, JSON.stringify(delivery ?? {})],
    );
    return map(updated.rows[0]);
  });
}

export function completePostCallSummaryJob(summaryJobId, result, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withPlatformAdminContext;
  return contextRunner(null, async (client) => {
    const updated = await client.query(
      `UPDATE call_ai_summaries
          SET status='completed',summary_text=$2,outcome=$3,customer_intent=$4,sentiment=$5,
              collected_data=$6::jsonb,follow_up_required=$7,follow_up_reason=$8,
              usage=$9::jsonb,provider_request_id=$10,duration_ms=$11,
              completed_at=now(),failed_at=NULL,error_code=NULL,error_message=NULL
        WHERE id=$1 AND status='processing'
        RETURNING *`,
      [summaryJobId, result.summary, result.outcome, result.customerIntent, result.sentiment,
        JSON.stringify(result.collectedData ?? {}), result.followUpRequired, result.followUpReason,
        JSON.stringify(result.usage ?? {}), result.providerRequestId ?? null, result.durationMs ?? 0],
    );
    if (!updated.rowCount) throw new AppError(409, 'Summary job is not processing', 'POSTCALL_SUMMARY_NOT_PROCESSING');
    return map(updated.rows[0]);
  });
}

export function skipPostCallSummaryJob(summaryJobId, reason, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withPlatformAdminContext;
  return contextRunner(null, async (client) => {
    const updated = await client.query(
      `UPDATE call_ai_summaries
          SET status='skipped',error_code=$2,error_message=$3,completed_at=now(),failed_at=NULL
        WHERE id=$1 AND status='processing' RETURNING *`,
      [summaryJobId, reason.code, String(reason.message ?? '').slice(0, 2000)],
    );
    if (!updated.rowCount) throw new AppError(409, 'Summary job is not processing', 'POSTCALL_SUMMARY_NOT_PROCESSING');
    return map(updated.rows[0]);
  });
}

export function failPostCallSummaryJob(summaryJobId, error, options = {}, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withPlatformAdminContext;
  return contextRunner(null, async (client) => {
    const selected = await client.query('SELECT attempt_count,max_attempts FROM call_ai_summaries WHERE id=$1 FOR UPDATE', [summaryJobId]);
    if (!selected.rowCount) throw new AppError(404, 'Post-Call summary job was not found', 'POSTCALL_SUMMARY_JOB_NOT_FOUND');
    const retry = options.retryable !== false
      && Number(selected.rows[0].attempt_count) < Number(selected.rows[0].max_attempts);
    const updated = await client.query(
      `UPDATE call_ai_summaries
          SET status=$2::postcall_summary_status,error_code=$3,error_message=$4,
              failed_at=CASE WHEN $2='failed' THEN now() ELSE NULL END,
              processing_started_at=CASE WHEN $2='queued' THEN NULL ELSE processing_started_at END
        WHERE id=$1 AND status='processing' RETURNING *`,
      [summaryJobId, retry ? 'queued' : 'failed', String(error?.code ?? 'POSTCALL_SUMMARY_FAILED').slice(0, 160),
        String(error?.message ?? error ?? 'Post-Call summarization failed').slice(0, 2000)],
    );
    if (!updated.rowCount) throw new AppError(409, 'Summary job is not processing', 'POSTCALL_SUMMARY_NOT_PROCESSING');
    return { retry, job: map(updated.rows[0]) };
  });
}
