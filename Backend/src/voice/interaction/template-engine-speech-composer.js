function cleanText(value, maximum = 4_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
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

function withoutNextQuestion(decision) {
  return Object.freeze({ ...decision, nextQuestion: null });
}

export function validateAndComposeTemplateEngineSpeech({
  decision, recentCompleteTurns = [], conversationGuidance = null,
  suppressFollowUp = false, claimsValidated = true,
  maximumSpeechCharacters = null,
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
  const configured = cleanText(conversationGuidance?.nextQuestion);
  let rejection = null;
  if (Number(maximumSpeechCharacters) > 0
    && `${answer} ${proposed}`.length > Number(maximumSpeechCharacters)) {
    rejection = 'speech_budget_exceeded';
  } else if (suppressFollowUp) rejection = 'turn_suppresses_follow_up';
  else if (!configured) rejection = 'not_supported_by_guidance';
  else if ((proposed.match(/[?\uFF1F]/gu) ?? []).length !== 1) rejection = 'not_exactly_one_question';
  else if ((answer.match(/[?\uFF1F]/gu) ?? []).length > 0) rejection = 'answer_already_contains_question';
  else if (containsInternalPayload(proposed)) rejection = 'internal_or_structured_question';
  else if (claimsValidated !== true) rejection = 'unsupported_question_claim';
  else if (identity(proposed) !== identity(configured)
    && overlapCoefficient(proposed, configured) < 0.35) rejection = 'unrelated_question';
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
    decision: acceptedDecision, speech: `${answer} ${proposed}`,
    followUp: Object.freeze({ accepted: true, reason: null }),
  });
}
