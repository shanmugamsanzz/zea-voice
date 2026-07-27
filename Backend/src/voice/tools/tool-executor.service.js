import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../middleware/errors.js';
import { validateToolArguments, validateToolHeaders, validateWebhookEndpoint } from './tool-security.js';

function safeName(value) {
  return String(value ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function configuredHeaders(tool) {
  const publicHeaders = tool.configuration?.headers ?? {};
  const secrets = tool.secretConfiguration ?? {};
  const secretHeaders = secrets.headers ?? secrets;
  const entries = (value) => Array.isArray(value)
    ? value.map((item) => [item.key ?? item.name, item.value]) : Object.entries(value ?? {});
  return Object.fromEntries([...entries(publicHeaders), ...entries(secretHeaders)]
    .map(([key, value]) => [String(key ?? '').trim(), String(value ?? '')])
    .filter(([key]) => key));
}

async function configuration(tool, dependencies = {}) {
  if (tool.type !== 'webhook_api') throw new AppError(409, `Tool type is not executable: ${tool.type}`, 'VOICE_TOOL_TYPE_UNSUPPORTED');
  const value = tool.configuration ?? {};
  const endpoint = value.url ?? value.endpoint ?? value.webhookUrl ?? value.webhook_url;
  if (!endpoint) throw new AppError(409, `Tool ${tool.name} has no endpoint`, 'VOICE_TOOL_ENDPOINT_MISSING');
  const url = await validateWebhookEndpoint(endpoint, {
    resolveDns: dependencies.resolveDns ?? env.NODE_ENV !== 'test', lookupFn: dependencies.lookupFn,
  });
  const method = String(value.method ?? 'POST').toUpperCase();
  if (!['POST', 'PUT', 'PATCH'].includes(method)) {
    throw new AppError(409, `Tool ${tool.name} has an unsupported method`, 'VOICE_TOOL_METHOD_INVALID');
  }
  const headers = configuredHeaders(tool);
  validateToolHeaders(value.headers ?? {});
  validateToolHeaders(tool.secretConfiguration?.headers ?? tool.secretConfiguration ?? {}, { secret: true });
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  const timeoutMs = Math.max(1000, Math.min(30000, Number(value.timeoutMs ?? env.VOICE_TOOL_TIMEOUT_MS)));
  return { url, method, headers, timeoutMs, inputSchema: value.inputSchema ?? value.input_schema ?? {} };
}

async function boundedPayload(response) {
  const declaredLength = Number(response.headers?.get?.('content-length') ?? 0);
  if (declaredLength > env.VOICE_TOOL_MAX_RESPONSE_BYTES) {
    throw new AppError(502, 'Tool response exceeded the configured size limit', 'VOICE_TOOL_RESPONSE_TOO_LARGE');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > env.VOICE_TOOL_MAX_RESPONSE_BYTES) throw new AppError(502, 'Tool response exceeded the configured size limit', 'VOICE_TOOL_RESPONSE_TOO_LARGE');
    try { return JSON.parse(text); } catch { return text || null; }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > env.VOICE_TOOL_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AppError(502, 'Tool response exceeded the configured size limit', 'VOICE_TOOL_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  try { return JSON.parse(text); } catch { return text || null; }
}

export async function executeAgentTool(runtimeProfile, call, toolCall, dependencies = {}) {
  const startedAt = performance.now();
  const tool = (runtimeProfile.tools ?? []).find((candidate) => safeName(candidate.name) === safeName(toolCall.name));
  if (!tool) throw new AppError(409, `Requested tool is not assigned to this agent: ${toolCall.name}`, 'VOICE_TOOL_NOT_ASSIGNED');
  const config = await configuration(tool, dependencies);
  const argumentsValue = validateToolArguments(toolCall.arguments ?? {}, config.inputSchema);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? config.timeoutMs;
  logger.info({ stage: 'voice.tool_started', toolId: tool.id, toolName: safeName(tool.name), callId: call.id }, 'Executing assigned voice tool');
  let response;
  try {
    response = await fetchImpl(config.url, {
      method: config.method,
      headers: config.headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        arguments: argumentsValue,
        context: {
          callId: call.id,
          providerCallId: call.providerCallId,
          tenantId: runtimeProfile.agent.tenantId,
          workspaceId: runtimeProfile.agent.workspaceId,
          agentId: runtimeProfile.agent.id,
          direction: call.direction,
        },
      }),
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new AppError(504, `Tool ${tool.name} timed out`, 'VOICE_TOOL_TIMEOUT');
    throw new AppError(502, `Tool ${tool.name} could not be reached`, 'VOICE_TOOL_NETWORK_FAILED');
  }
  const output = await boundedPayload(response);
  if (!response.ok) throw new AppError(502, `Tool ${tool.name} returned HTTP ${response.status}`, 'VOICE_TOOL_REQUEST_FAILED', {
    toolId: tool.id, status: response.status,
  });
  const result = {
    id: toolCall.id ?? null, toolId: tool.id, name: safeName(tool.name), success: true, output,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
  logger.info({ stage: 'voice.tool_completed', toolId: tool.id, toolName: result.name, callId: call.id, durationMs: result.durationMs }, 'Assigned voice tool completed');
  return result;
}

export async function executeAgentTools(runtimeProfile, call, toolCalls, dependencies = {}) {
  const results = [];
  for (const toolCall of toolCalls ?? []) {
    const startedAt = performance.now();
    try {
      results.push(await executeAgentTool(runtimeProfile, call, toolCall, dependencies));
    } catch (error) {
      const assignedTool = (runtimeProfile.tools ?? [])
        .find((candidate) => safeName(candidate.name) === safeName(toolCall.name));
      const result = {
        id: toolCall.id ?? null, toolId: assignedTool?.id ?? null,
        name: safeName(toolCall.name), success: false,
        error: { code: error.code ?? 'VOICE_TOOL_FAILED', message: error.message },
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      };
      logger.warn({ stage: 'voice.tool_failed', toolName: result.name, callId: call.id, errorCode: result.error.code, durationMs: result.durationMs }, 'Assigned voice tool failed');
      results.push(result);
    }
  }
  return results;
}
