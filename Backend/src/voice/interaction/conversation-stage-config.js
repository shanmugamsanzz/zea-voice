const keyPattern = /^[a-z][a-z0-9_-]{0,79}$/;

function cleanKey(value, fallback = '') {
  const key = String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, '_');
  return keyPattern.test(key) ? key : fallback;
}

export function resolveConversationStageConfiguration(settings = {}, { strict = false } = {}) {
  const rawInitial = String(settings.conversationInitialStage ?? '').trim();
  const initialStage = cleanKey(rawInitial, 'start');
  if (strict && rawInitial && initialStage !== rawInitial.toLowerCase().replace(/\s+/gu, '_')) {
    const error = new TypeError('Initial Conversation Stage must use lowercase letters, numbers, underscores or hyphens');
    error.code = 'CONVERSATION_STAGE_CONFIGURATION_INVALID';
    error.field = 'conversationInitialStage';
    throw error;
  }
  return Object.freeze({ initialStage });
}

export function normalizeConversationStageSettings(settings = {}) {
  const configuration = resolveConversationStageConfiguration(settings, { strict: true });
  return { ...settings, conversationInitialStage: configuration.initialStage };
}

export function workflowStageGate(workflow, { currentStage, selectedCatalogItemId } = {}) {
  const conditions = workflow?.conditions ?? {};
  const actionConfig = workflow?.action_config ?? workflow?.actionConfig ?? {};
  const fromStages = Array.isArray(conditions.fromStages)
    ? conditions.fromStages.map((value) => cleanKey(value)).filter(Boolean)
    : [];
  const stage = cleanKey(currentStage, 'start');
  if (fromStages.length && !fromStages.includes(stage)) {
    return Object.freeze({ allowed: false, reason: 'stage_transition_not_allowed', stage });
  }
  if (actionConfig.requiresCatalogItem === true && !selectedCatalogItemId) {
    return Object.freeze({ allowed: false, reason: 'catalog_item_required', stage });
  }
  return Object.freeze({
    allowed: true,
    reason: null,
    stage,
    nextStage: cleanKey(actionConfig.nextStage),
    actionKey: cleanKey(actionConfig.actionKey),
  });
}
