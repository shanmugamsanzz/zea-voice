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

function verifiedOutcome(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  if (typeof output.success === 'boolean') return output.success;
  if (typeof output.ok === 'boolean') return output.ok;
  return false;
}

export async function executeAgentTool(runtimeProfile, call, toolCall, dependencies = {}) {
  const startedAt = performance.now();
  const authorizationRecordId = String(toolCall?.authorizationRecordId ?? '').trim();
  const executionAuthorization = dependencies.workflowAuthorization ?? {};
  const workflowAuthorized = authorizationRecordId
    && authorizationRecordId === String(executionAuthorization.recordId ?? '').trim()
    && safeName(toolCall?.name) === safeName(executionAuthorization.toolName);
  if (dependencies.requireWorkflowAuthorization === true && !workflowAuthorized) {
    throw new AppError(
      409,
      'The configured Workflow did not authorize this tool execution',
      'VOICE_TOOL_WORKFLOW_AUTHORIZATION_REQUIRED',
    );
  }
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
  const success = verifiedOutcome(output);
  const result = {
    id: toolCall.id ?? null, toolId: tool.id, name: safeName(tool.name), success,
    verified: true, output,
    ...(success ? {} : { error: { code: 'VOICE_TOOL_REPORTED_FAILURE', message: 'The tool reported an unsuccessful result' } }),
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
  const logResult = success ? logger.info.bind(logger) : logger.warn.bind(logger);
  logResult({
    stage: success ? 'voice.tool_completed' : 'voice.tool_reported_failure',
    toolId: tool.id, toolName: result.name, callId: call.id, durationMs: result.durationMs,
  }, success ? 'Assigned voice tool completed' : 'Assigned voice tool reported an unsuccessful result');
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
        name: safeName(toolCall.name), success: false, verified: true,
        error: { code: error.code ?? 'VOICE_TOOL_FAILED', message: error.message },
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      };
      logger.warn({ stage: 'voice.tool_failed', toolName: result.name, callId: call.id, errorCode: result.error.code, durationMs: result.durationMs }, 'Assigned voice tool failed');
      results.push(result);
    }
  }
  return results;
}
