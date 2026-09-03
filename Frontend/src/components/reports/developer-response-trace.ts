export type DeveloperTraceRole = 'SUPER_ADMIN' | 'DEVELOPER' | 'USER';

export type TraceMetadataValue = string | number | boolean | null
  | ReadonlyArray<string | number | boolean | null>;

export type TraceSourceType = 'welcome_configuration' | 'system_prompt' | 'pre_call_context'
  | 'conversation_memory' | 'knowledge' | 'tool' | 'llm' | 'silent_message'
  | 'call_check_configuration' | 'runtime_fallback' | 'post_call_closing';

export interface TraceSource {
  type: TraceSourceType;
  id: string | number | boolean | null;
  label: string | number | boolean | null;
  metadata: Record<string, TraceMetadataValue>;
}

function text(value: TraceMetadataValue | undefined) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value).trim() : '';
}

export function canViewDeveloperResponseTrace(role: DeveloperTraceRole) {
  return role === 'SUPER_ADMIN' || role === 'DEVELOPER';
}

export function latestFiniteMetric<T extends Record<string, unknown>>(
  samples: T[],
  key: keyof T,
) {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const value = samples[index]?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function buildDeveloperResponseTrace(sources: TraceSource[]) {
  const decision = sources.find((source) => (
    source.type === 'llm' && text(source.metadata?.engine) === 'template_engine_v1'
  ));
  if (!decision) return null;
  const initialDecision = text(decision.metadata.initialDecision);
  const finalDecision = text(decision.metadata.finalDecision);
  const route = initialDecision && finalDecision && initialDecision !== finalDecision
    ? `${initialDecision} → ${finalDecision}`
    : initialDecision || finalDecision || 'UNKNOWN';
  const knowledgeSources = sources.filter((source) => source.type === 'knowledge');
  const tool = sources.find((source) => source.type === 'tool');
  const workflowId = text(decision.metadata.workflowId) || text(tool?.metadata.workflowId);
  const toolStatus = text(tool?.metadata.status);
  const toolResult = tool?.metadata.success === true ? 'success'
    : tool?.metadata.success === false ? 'failed'
      : toolStatus || null;
  return Object.freeze({
    route,
    initialDecision: initialDecision || null,
    finalDecision: finalDecision || null,
    validationResult: text(decision.metadata.validationResult) || null,
    clarificationReason: text(decision.metadata.clarificationReason) || null,
    workflowId: workflowId || null,
    toolId: text(decision.metadata.toolId) || text(tool?.id) || null,
    toolResult,
    knowledgeSources: Object.freeze(knowledgeSources),
    sourcesRequired: initialDecision === 'SEARCH',
  });
}
