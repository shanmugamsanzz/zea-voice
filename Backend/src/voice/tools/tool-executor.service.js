import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errors.js';

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

function configuration(tool) {
  const value = tool.configuration ?? {};
  const endpoint = value.url ?? value.endpoint ?? value.webhookUrl ?? value.webhook_url;
  if (!endpoint) throw new AppError(409, `Tool ${tool.name} has no endpoint`, 'VOICE_TOOL_ENDPOINT_MISSING');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AppError(409, `Tool ${tool.name} must use HTTP or HTTPS`, 'VOICE_TOOL_ENDPOINT_INVALID');
  }
  if (env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new AppError(409, `Tool ${tool.name} must use HTTPS in production`, 'VOICE_TOOL_HTTPS_REQUIRED');
  }
  const method = String(value.method ?? 'POST').toUpperCase();
  if (!['POST', 'PUT', 'PATCH'].includes(method)) {
    throw new AppError(409, `Tool ${tool.name} has an unsupported method`, 'VOICE_TOOL_METHOD_INVALID');
  }
  const headers = configuredHeaders(tool);
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  return { url: url.toString(), method, headers };
}

async function boundedPayload(response) {
  const text = (await response.text()).slice(0, env.VOICE_TOOL_MAX_RESPONSE_BYTES);
  try { return JSON.parse(text); } catch { return text || null; }
}

export async function executeAgentTool(runtimeProfile, call, toolCall, dependencies = {}) {
  const startedAt = performance.now();
  const tool = (runtimeProfile.tools ?? []).find((candidate) => safeName(candidate.name) === safeName(toolCall.name));
  if (!tool) throw new AppError(409, `Requested tool is not assigned to this agent: ${toolCall.name}`, 'VOICE_TOOL_NOT_ASSIGNED');
  const config = configuration(tool);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? env.VOICE_TOOL_TIMEOUT_MS;
  const response = await fetchImpl(config.url, {
    method: config.method,
    headers: config.headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      arguments: toolCall.arguments ?? {},
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
  const output = await boundedPayload(response);
  if (!response.ok) throw new AppError(502, `Tool ${tool.name} returned HTTP ${response.status}`, 'VOICE_TOOL_REQUEST_FAILED', {
    toolId: tool.id, status: response.status,
  });
  return {
    id: toolCall.id ?? null, name: safeName(tool.name), success: true, output,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}

export async function executeAgentTools(runtimeProfile, call, toolCalls, dependencies = {}) {
  const results = [];
  for (const toolCall of toolCalls ?? []) {
    const startedAt = performance.now();
    try {
      results.push(await executeAgentTool(runtimeProfile, call, toolCall, dependencies));
    } catch (error) {
      results.push({
        id: toolCall.id ?? null, name: safeName(toolCall.name), success: false,
        error: { code: error.code ?? 'VOICE_TOOL_FAILED', message: error.message },
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    }
  }
  return results;
}
