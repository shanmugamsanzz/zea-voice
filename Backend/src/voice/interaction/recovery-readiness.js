import { AppError } from '../../middleware/errors.js';
import { resolveRuntimeMessage } from './configured-runtime-messages.js';

export function isInternalRuntimeText(value) {
  const text = String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
  if (!text) return true;
  return /(?:runtime_context|grounded_response_contract|response_mode|action_config|selectedentitykeys|evidencesourceids|flowaction|catalog_item_required)/iu.test(text)
    || /\bstart or resume the configured\b/iu.test(text)
    || /\buse (?:only )?the configured\b/iu.test(text)
    || /^\s*(?:instruction|action|workflow|response)\s*:/iu.test(text);
}

// Shared by agent writes and production profile admission. Never supply an
// engine-authored fallback: the tenant must approve caller-facing wording.
export function validateRecoveryReadiness(settings = {}, { required = true, requiresWorkflowRecovery = false } = {}) {
  const profile = { agent: { settings } };
  const fields = [
    ['nonFactualRecoveryMessage', 'non_factual_recovery'],
    ['evidenceValidationFailureMessage', 'evidence_validation_failure'],
    ['workflowConfigurationFailureMessage', 'workflow_configuration_failure'],
  ];
  const usable = {};
  for (const [key, role] of fields) {
    const raw = settings[key];
    const text = String(raw ?? '').normalize('NFKC').trim();
    const rendered = resolveRuntimeMessage(profile, role);
    if (text && (typeof raw !== 'string' || text.length > 500
      || /\{\{[\s\S]*?\}\}/u.test(text) || isInternalRuntimeText(rendered))) {
      throw new AppError(400, 'Recovery wording must be complete caller-facing text of at most 500 characters',
        'AGENT_RECOVERY_MESSAGE_INVALID', { field: `settings.${key}` });
    }
    usable[key] = Boolean(rendered) && !isInternalRuntimeText(rendered);
  }
  if (required && !usable.nonFactualRecoveryMessage
    && !(usable.evidenceValidationFailureMessage && usable.workflowConfigurationFailureMessage)) {
    throw new AppError(400, 'Configure approved recovery wording before activating or loading the agent',
      'AGENT_NEUTRAL_RECOVERY_MESSAGE_REQUIRED', { field: 'settings.nonFactualRecoveryMessage' });
  }
  if (required && requiresWorkflowRecovery && !usable.workflowConfigurationFailureMessage) {
    throw new AppError(400, 'Approve a dedicated configuration-failure message before loading an agent with tools; rephrasing cannot repair configuration',
      'AGENT_WORKFLOW_RECOVERY_MESSAGE_REQUIRED', { field: 'settings.workflowConfigurationFailureMessage' });
  }
}
