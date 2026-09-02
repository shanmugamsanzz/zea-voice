const settingKeys = Object.freeze({
  acknowledgement: Object.freeze(['latencyAcknowledgementMessage']),
  clarification: Object.freeze(['knowledgeClarificationMessage', 'noResponseMessage']),
  clarification_recovery_support: Object.freeze(['clarificationRecoverySupportMessage']),
  information_unavailable: Object.freeze([
    'informationUnavailableMessage', 'knowledgeUnavailableMessage',
  ]),
  technical_failure: Object.freeze([
    'technicalFailureMessage', 'knowledgeTechnicalFailureMessage', 'errorRecoveryMessage',
  ]),
  evidence_validation_failure: Object.freeze([
    'evidenceValidationFailureMessage', 'technicalFailureMessage',
    'knowledgeTechnicalFailureMessage',
  ]),
  recovery: Object.freeze(['errorRecoveryMessage', 'technicalFailureMessage']),
  closing: Object.freeze(['closingMessage', 'postCallClosingMessage']),
});

function clean(value, maximum = 1_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function normalizedRole(value) {
  return clean(value, 100).toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

function configured(profile, role) {
  const settings = profile?.agent?.settings ?? {};
  for (const key of settingKeys[role] ?? []) {
    const message = clean(settings[key]);
    if (message) return message;
  }
  return '';
}

function evidenceValues(knowledge = {}) {
  const tenantEvidence = knowledge?.tenantEvidence ?? {};
  return [...(tenantEvidence.guidanceEvidence ?? []), ...(tenantEvidence.sources ?? [])];
}

function evidenceRole(source = {}) {
  const data = source.authoritativeData ?? {};
  return normalizedRole(data.runtimeMessageRole ?? data.messageRole ?? data.responseRole);
}

function published(knowledge, role) {
  const expected = normalizedRole(role);
  const source = evidenceValues(knowledge).find((candidate) => (
    candidate?.callerFacing === true
    && evidenceRole(candidate) === expected
    && clean(candidate.content)
  ));
  return source ? clean(source.content) : '';
}

function render(message, variables = {}) {
  return clean(message.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/giu, (match, key) => (
    clean(variables[key], 500)
  )));
}

export function resolveRuntimeMessage(profile, role, knowledge = {}, variables = {}) {
  const message = configured(profile, role) || published(knowledge, role);
  return message ? render(message, variables) : '';
}
