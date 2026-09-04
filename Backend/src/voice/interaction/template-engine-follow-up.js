function cleanText(value, maximum = 4_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

const followUpRepairReasons = new Set([
  'not_proposed', 'not_exactly_one_question', 'internal_or_structured_question',
  'unsupported_question_claim', 'unrelated_question',
]);

export const templateEngineFollowUpRepairJsonSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  required: Object.freeze(['nextQuestion']),
  properties: Object.freeze({
    nextQuestion: Object.freeze({
      type: 'object', additionalProperties: false,
      required: Object.freeze(['question', 'reason']),
      properties: Object.freeze({
        question: Object.freeze({ type: 'string' }),
        reason: Object.freeze({
          anyOf: Object.freeze([
            Object.freeze({ type: 'string' }), Object.freeze({ type: 'null' }),
          ]),
        }),
      }),
    }),
  }),
});

function completionOutput(completion) {
  if (completion && typeof completion === 'object') {
    return completion.outputParsed ?? completion.output_parsed ?? completion.parsed
      ?? completion.answer ?? completion.output ?? completion.text ?? completion;
  }
  return completion;
}

function safeObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function repairTemplateEngineFollowUp({
  decision, mainPrompt, latestUtterance, recentCompleteTurns = [],
  conversationGuidance, initialValidation, invokeStructuredLlm,
} = {}) {
  const reason = cleanText(initialValidation?.reason, 160);
  const applicable = decision?.decision === 'RESPONSE'
    && cleanText(conversationGuidance?.nextQuestion)
    && followUpRepairReasons.has(reason)
    && typeof invokeStructuredLlm === 'function';
  if (!applicable) {
    return Object.freeze({ decision, attempted: false, reason: reason || 'not_applicable' });
  }
  const repairInput = Object.freeze({
    latestUtterance: cleanText(latestUtterance, 2_000),
    recentCompleteTurns: Object.freeze((Array.isArray(recentCompleteTurns)
      ? recentCompleteTurns : []).slice(-10)),
    answer: cleanText(decision.response),
    conversationGuidance: Object.freeze({
      purpose: cleanText(conversationGuidance.purpose, 1_500),
      nextQuestion: cleanText(conversationGuidance.nextQuestion, 1_500),
      conversationStage: cleanText(conversationGuidance.conversationStage, 160) || null,
    }),
    rejectedReason: reason,
  });
  const messages = Object.freeze([
    Object.freeze({
      role: 'system',
      content: [
        cleanText(mainPrompt, 24_000),
        'The caller-facing answer is already validated. Generate exactly one concise follow-up question only.',
        'Use the supplied published Conversation Guidance as meaning guidance and phrase it naturally in the caller\'s active language.',
        'Do not repeat a completed question, change the answer, add facts, or expose internal data.',
        'Return exactly the supplied JSON schema, not Markdown or commentary.',
      ].filter(Boolean).join('\n'),
    }),
    Object.freeze({ role: 'user', content: JSON.stringify(repairInput) }),
  ]);
  try {
    const completion = await invokeStructuredLlm(Object.freeze({
      messages,
      temperature: 0,
      responseFormat: Object.freeze({
        type: 'json_schema', name: 'template_engine_follow_up_repair', strict: true,
        schema: templateEngineFollowUpRepairJsonSchema,
      }),
    }));
    const parsed = safeObject(completionOutput(completion));
    const value = parsed?.nextQuestion;
    const question = cleanText(value?.question, 1_000);
    const repairedReason = value?.reason === null ? null : cleanText(value?.reason, 500);
    if (!parsed || Object.keys(parsed).length !== 1
      || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('|') !== 'question|reason'
      || !question || (value.reason !== null && !repairedReason)) {
      return Object.freeze({ decision, attempted: true, reason: 'repair_output_invalid' });
    }
    return Object.freeze({
      decision: Object.freeze({
        ...decision,
        nextQuestion: Object.freeze({ question, reason: repairedReason }),
      }),
      attempted: true,
      reason: null,
    });
  } catch (error) {
    return Object.freeze({
      decision, attempted: true, reason: 'repair_provider_failure',
      errorCode: cleanText(error?.code, 160) || null,
    });
  }
}

function identity(value) {
  return cleanText(value).toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function tokens(value) {
  return new Set(identity(value).split(/\s+/u).filter((token) => token.length > 1));
}

function overlapCoefficient(left, right) {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return shared / Math.min(leftTokens.size, rightTokens.size);
}

function questionCount(value) {
  return (cleanText(value).match(/[?\uFF1F]/gu) ?? []).length;
}

function containsInternalPayload(value) {
  const speech = cleanText(value);
  if (!speech) return true;
  if (/```|<(?:platform|tenant|orchestrator|workflow|runtime)_[^>]*>/iu.test(speech)
    || /"(?:decision|stateUpdate|evidenceIds|tool|search)"\s*:/iu.test(speech)) return true;
  return (speech.startsWith('{') && speech.endsWith('}'))
    || (speech.startsWith('[') && speech.endsWith(']'));
}

function repeatedQuestion(question, turns) {
  const wanted = identity(question);
  if (!wanted) return true;
  return (Array.isArray(turns) ? turns : []).filter((turn) => (
    ['assistant', 'agent'].includes(String(turn?.role ?? '').toLocaleLowerCase())
  )).some((turn) => {
    const prior = identity(turn?.content ?? turn?.text);
    return prior === wanted || prior.includes(wanted) || overlapCoefficient(prior, wanted) >= 0.9;
  });
}

function relevantQuestion(question, guidance) {
  const configured = cleanText(guidance?.nextQuestion);
  if (!configured) return false;
  return identity(question) === identity(configured)
    || overlapCoefficient(question, configured) >= 0.35;
}

function withoutNextQuestion(decision) {
  return Object.freeze({ ...decision, nextQuestion: null });
}

export function candidateTemplateEngineSpeech(decision) {
  if (decision?.decision === 'CLARIFY') return cleanText(decision.clarification?.question);
  if (!['RESPONSE', 'NO_MATCH'].includes(decision?.decision)) return '';
  return [cleanText(decision.response), cleanText(decision.nextQuestion?.question)]
    .filter(Boolean).join(' ');
}

export function validateAndComposeTemplateEngineSpeech({
  decision,
  recentCompleteTurns = [],
  conversationGuidance = null,
  suppressFollowUp = false,
  claimsValidated = true,
} = {}) {
  if (decision?.decision === 'CLARIFY') {
    return Object.freeze({
      decision, speech: cleanText(decision.clarification?.question),
      followUp: Object.freeze({ accepted: false, reason: 'clarification_is_the_question' }),
    });
  }
  if (!['RESPONSE', 'NO_MATCH'].includes(decision?.decision)) {
    return Object.freeze({
      decision, speech: '',
      followUp: Object.freeze({ accepted: false, reason: 'decision_has_no_speech' }),
    });
  }
  const answer = cleanText(decision.response);
  const proposed = cleanText(decision.nextQuestion?.question);
  if (!proposed) {
    return Object.freeze({
      decision: withoutNextQuestion(decision), speech: answer,
      followUp: Object.freeze({ accepted: false, reason: 'not_proposed' }),
    });
  }
  let rejection = null;
  if (decision.decision !== 'RESPONSE') rejection = 'decision_disallows_follow_up';
  else if (suppressFollowUp) rejection = 'turn_suppresses_follow_up';
  else if (!cleanText(conversationGuidance?.nextQuestion)) rejection = 'not_supported_by_guidance';
  else if (questionCount(proposed) !== 1) rejection = 'not_exactly_one_question';
  else if (questionCount(answer) > 0) rejection = 'answer_already_contains_question';
  else if (containsInternalPayload(proposed)) rejection = 'internal_or_structured_question';
  else if (claimsValidated !== true) rejection = 'unsupported_question_claim';
  else if (!relevantQuestion(proposed, conversationGuidance)) rejection = 'unrelated_question';
  else if (repeatedQuestion(proposed, recentCompleteTurns)) rejection = 'repeated_question';
  if (rejection) {
    return Object.freeze({
      decision: withoutNextQuestion(decision), speech: answer,
      followUp: Object.freeze({ accepted: false, reason: rejection }),
    });
  }
  const acceptedDecision = Object.freeze({
    ...decision,
    nextQuestion: Object.freeze({ ...decision.nextQuestion, question: proposed }),
  });
  return Object.freeze({
    decision: acceptedDecision,
    speech: `${answer} ${proposed}`,
    followUp: Object.freeze({ accepted: true, reason: null }),
  });
}
