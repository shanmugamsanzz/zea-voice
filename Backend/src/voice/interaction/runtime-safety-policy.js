function text(value, maximum = 4_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) {
  return text(value).toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

// These are platform injection/control markers, not tenant/business intents.
// Retrieved documents remain untrusted data and cannot redefine runtime rules.
export function containsInstructionLeakage(value) {
  const normalized = identity(value);
  return /(?:ignore (?:all |the )?(?:previous|prior|system|developer) instructions?|reveal (?:the )?(?:system|developer) prompt|hidden instructions?|act as (?:the )?(?:system|developer)|execute (?:this )?(?:tool|command)|grounded response contract|runtime context|evidenceids|stateupdate|toolrequest)/iu
    .test(normalized);
}

function configuredPolicies(value) {
  const policies = Array.isArray(value) ? value : [];
  return policies.filter((policy) => policy && typeof policy === 'object' && policy.enabled !== false);
}

export function validateConfiguredSafety({ answer = '', toolRequest = null, policies = [] } = {}) {
  if (containsInstructionLeakage(answer)) return Object.freeze({ valid: false, reason: 'instruction_leakage' });
  const normalizedAnswer = identity(answer);
  const toolName = identity(toolRequest?.name);
  for (const policy of configuredPolicies(policies)) {
    const id = text(policy.id ?? policy.key, 120) || 'configured_policy';
    const blockedPhrases = Array.isArray(policy.blockedPhrases) ? policy.blockedPhrases : [];
    if (blockedPhrases.some((phrase) => {
      const candidate = identity(phrase);
      return candidate && normalizedAnswer.includes(candidate);
    })) return Object.freeze({ valid: false, reason: 'configured_safety_policy', policyId: id });
    const blockedTools = Array.isArray(policy.blockedTools) ? policy.blockedTools : [];
    if (toolName && blockedTools.some((name) => identity(name) === toolName)) {
      return Object.freeze({ valid: false, reason: 'configured_tool_policy', policyId: id });
    }
  }
  return Object.freeze({ valid: true });
}
