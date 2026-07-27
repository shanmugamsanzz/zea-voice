import { performance } from 'node:perf_hooks';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ProviderAdapterRegistry } from '../providers/registry.js';
import { registerImplementedProviderAdapters } from '../providers/defaults.js';
import { reportPostCall } from '../integrations/postcall.service.js';
import {
  claimPostCallSummaryJob, completePostCallSummaryJob, failPostCallSummaryJob,
  recordPostCallSummaryWebhookDelivery, skipPostCallSummaryJob,
} from './postcall-summary-job.service.js';
import { buildPostCallSummaryMessages, normalizePostCallSummaryOutput } from './postcall-summary-output.js';

const nonRetryableCodes = new Set([
  'POSTCALL_SUMMARY_JOB_NOT_FOUND', 'POSTCALL_SUMMARY_MODEL_UNAVAILABLE',
  'VOICE_PROVIDER_ADAPTER_NOT_FOUND', 'VOICE_PROVIDER_MODEL_INCOMPATIBLE',
  'VOICE_PROVIDER_STREAMING_UNSUPPORTED', 'LLM_API_KEY_MISSING', 'LLM_API_URL_MISSING',
  'LLM_API_URL_INVALID', 'CREDENTIAL_DECRYPTION_FAILED',
]);

function retryable(error) {
  return error?.retryable !== false && !nonRetryableCodes.has(error?.code);
}

function usageRecord(job, usage, finishReason) {
  return {
    providerId: job.provider.providerId,
    provider: job.provider.providerName,
    modelId: job.provider.modelId,
    model: job.provider.modelKey,
    inputTokens: Number(usage?.inputTokens ?? 0),
    outputTokens: Number(usage?.outputTokens ?? 0),
    totalTokens: Number(usage?.totalTokens ?? 0),
    cachedInputTokens: Number(usage?.cachedInputTokens ?? 0),
    requestCount: 1,
    finishReason: finishReason ?? null,
  };
}

function postCallPayload(job, structured = {}, summaryUsage = {}, summaryStatus = 'completed') {
  return {
    event: 'call.completed',
    call: {
      id: job.callSessionId,
      providerCallId: job.call.providerCallId,
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      agentId: job.agentId,
      direction: job.call.direction,
      status: job.call.status,
      reason: job.call.reason,
      startedAt: job.call.startedAt,
      answeredAt: job.call.answeredAt,
      endedAt: job.call.endedAt,
      durationSeconds: job.call.durationSeconds,
      fromNumber: job.call.fromNumber,
      toNumber: job.call.toNumber,
    },
    ...(job.includeTranscriptInWebhook ? { transcript: job.transcript } : {}),
    providerUsage: job.providerUsage,
    ...(job.includeSummaryInWebhook ? {
      aiSummary: {
        status: summaryStatus, ...structured,
        providerId: job.provider.providerId,
        modelId: job.provider.modelId,
        model: job.provider.modelKey,
        usage: summaryUsage,
      },
    } : {}),
  };
}

async function deliverFinalWebhook(job, payload, dependencies) {
  const deliverWebhook = dependencies.deliverWebhook ?? reportPostCall;
  const recordWebhook = dependencies.recordWebhook ?? recordPostCallSummaryWebhookDelivery;
  let webhook;
  try {
    webhook = await deliverWebhook({ agent: job.agent }, payload, {
      fetchImpl: dependencies.webhookFetchImpl,
      timeoutMs: dependencies.webhookTimeoutMs,
    });
    const persisted = await recordWebhook(job.id, webhook, dependencies.jobServiceDependencies);
    return { webhook, persisted };
  } catch (error) {
    webhook = {
      attempted: true, delivered: false, status: null, response: null,
      error: String(error?.message ?? error), durationMs: 0,
    };
    logger.error({
      err: error, stage: 'postcall_summary.webhook_persistence_failed',
      summaryJobId: job.id, callId: job.callSessionId, tenantId: job.tenantId,
    }, 'Post-Call webhook delivery result could not be persisted');
    return { webhook, persisted: null };
  }
}

export async function executePostCallSummaryJob(summaryJobId, attemptContext = {}, dependencies = {}) {
  const claim = dependencies.claim ?? claimPostCallSummaryJob;
  const complete = dependencies.complete ?? completePostCallSummaryJob;
  const fail = dependencies.fail ?? failPostCallSummaryJob;
  const skip = dependencies.skip ?? skipPostCallSummaryJob;
  const claimed = await claim(summaryJobId, dependencies.jobServiceDependencies);
  if (!claimed.claimed) return { processed: false, reason: claimed.reason, job: claimed.job };
  const job = claimed.job;
  if (!job.transcript.length) {
    const skipped = await skip(summaryJobId, {
      code: 'POSTCALL_SUMMARY_TRANSCRIPT_EMPTY', message: 'Call has no final transcript to summarize',
    }, dependencies.jobServiceDependencies);
    const delivery = await deliverFinalWebhook(job, postCallPayload(job, {
      reason: 'transcript_empty',
    }, {}, 'skipped'), dependencies);
    return { processed: true, status: 'skipped', job: delivery.persisted ?? skipped, webhook: delivery.webhook };
  }

  const registry = dependencies.registry ?? registerImplementedProviderAdapters(new ProviderAdapterRegistry());
  let adapter;
  const startedAt = performance.now();
  try {
    adapter = dependencies.adapter ?? await registry.create('llm', job.provider, {
      callId: job.callSessionId,
      fetchImpl: dependencies.fetchImpl,
      timeoutMs: dependencies.timeoutMs ?? env.POSTCALL_SUMMARY_TIMEOUT_MS,
      breaker: dependencies.breaker,
    });
    let text = '';
    let usage = {};
    let providerRequestId = null;
    let finishReason = null;
    for await (const event of adapter.stream({
      messages: buildPostCallSummaryMessages(job, {
        maximumTranscriptCharacters: dependencies.maximumTranscriptCharacters
          ?? env.POSTCALL_SUMMARY_TRANSCRIPT_MAX_CHARS,
      }),
      tools: [],
      temperature: 0,
      maxOutputTokens: dependencies.maxOutputTokens ?? env.POSTCALL_SUMMARY_MAX_OUTPUT_TOKENS,
    })) {
      if (event.type === 'text_delta') text += event.delta;
      if (event.type === 'usage' || event.type === 'completed') usage = event.usage ?? usage;
      if (event.providerRequestId) providerRequestId = event.providerRequestId;
      if (event.type === 'completed') finishReason = event.finishReason ?? null;
      if (event.type === 'error') {
        throw Object.assign(new Error(event.message), { code: event.code, retryable: event.retryable });
      }
    }
    const structured = normalizePostCallSummaryOutput(text);
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    const summaryUsage = usageRecord(job, usage, finishReason);
    const completed = await complete(summaryJobId, {
      ...structured,
      usage: summaryUsage,
      providerRequestId,
      durationMs,
    }, dependencies.jobServiceDependencies);
    const delivery = await deliverFinalWebhook(
      job, postCallPayload(job, structured, summaryUsage), dependencies,
    );
    logger.info({
      stage: 'postcall_summary.completed', summaryJobId, callId: job.callSessionId,
      tenantId: job.tenantId, modelId: job.modelId, durationMs,
      totalTokens: Number(usage?.totalTokens ?? 0), attempt: attemptContext.attempt ?? job.attemptCount,
    }, 'Post-Call AI summary completed');
    return { processed: true, status: 'completed', job: delivery.persisted ?? completed, webhook: delivery.webhook };
  } catch (error) {
    const failure = await fail(summaryJobId, error, { retryable: retryable(error) }, dependencies.jobServiceDependencies);
    logger[failure.retry ? 'warn' : 'error']({
      err: error, stage: failure.retry ? 'postcall_summary.retry_queued' : 'postcall_summary.failed',
      summaryJobId, callId: job.callSessionId, tenantId: job.tenantId,
      attempt: attemptContext.attempt ?? job.attemptCount, maxAttempts: attemptContext.maxAttempts ?? job.maxAttempts,
    }, failure.retry ? 'Post-Call summary will be retried' : 'Post-Call summary failed permanently');
    if (failure.retry) throw error;
    const delivery = await deliverFinalWebhook(job, postCallPayload(job, {
      errorCode: String(error?.code ?? 'POSTCALL_SUMMARY_FAILED'),
    }, {}, 'failed'), dependencies);
    return {
      processed: true, status: 'failed', job: delivery.persisted ?? failure.job, webhook: delivery.webhook,
    };
  } finally {
    await adapter?.close?.();
  }
}
