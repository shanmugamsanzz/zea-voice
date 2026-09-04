import { AppError } from '../../middleware/errors.js';

export const TEMPLATE_ENGINE_CUTOVER_VERSION = 1;
export const templateEngineModes = Object.freeze({
  LEGACY: 'legacy', SHADOW: 'shadow', ACTIVE: 'active',
});

export const requiredTemplateEngineScenarios = Object.freeze([
  'greetings', 'acknowledgements', 'call_purpose', 'overview', 'direct_entities',
  'phonetic_variations', 'prices_and_details', 'contextual_follow_ups',
  'comparisons', 'corrections', 'topic_switching', 'missing_information',
  'workflow_activation', 'partial_field_collection', 'confirmation',
  'cancellation', 'tool_success', 'tool_timeout', 'tool_failure',
  'tts_completion', 'silent_turn_prevention',
]);

function cleanText(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function safeClone(value, maximumCharacters = 100_000) {
  const serialized = JSON.stringify(value ?? null);
  if (serialized.length > maximumCharacters) {
    throw new TypeError('Template-engine shadow input exceeds its safe size');
  }
  return JSON.parse(serialized);
}

function boundedTimeout(value) {
  const timeout = Number(value);
  return Number.isInteger(timeout) && timeout >= 100 && timeout <= 30_000 ? timeout : 5_000;
}

function mode(value) {
  const normalized = cleanText(value, 20).toLocaleLowerCase() || templateEngineModes.LEGACY;
  if (!Object.values(templateEngineModes).includes(normalized)) {
    throw new TypeError('Unsupported template-engine cutover mode');
  }
  return normalized;
}

function zeroViolations(evidence) {
  return [
    'crossTenantLeakage', 'unrelatedEvidence', 'hallucinations',
    'unauthorizedTools', 'falseTechnicalFallbacks', 'silentTurns',
    'technicalFallbacks', 'malformedOutputs', 'falseNoMatches',
    'missedWorkflowActivations',
  ].every((field) => Number(evidence?.[field] ?? 0) === 0);
}

function validScenarioRuns(evidence, scenarios, repeats) {
  const runs = Array.isArray(evidence?.scenarioRuns) ? evidence.scenarioRuns : [];
  if (!runs.length) return false;
  return [...scenarios].every((scenario) => {
    const matching = runs.filter((run) => cleanText(run?.scenario, 120) === scenario);
    if (matching.length < repeats) return false;
    const tenants = new Set(matching.map((run) => cleanText(run?.tenantId, 160)).filter(Boolean));
    const languages = new Set(matching.map((run) => cleanText(run?.language, 40)).filter(Boolean));
    return tenants.size >= 2 && languages.size >= 2 && matching.every((run) => (
      run?.passed === true
      && run?.outputValid === true
      && run?.speechDelivered === true
      && cleanText(run?.expectedDecision, 40).toLocaleUpperCase()
        === cleanText(run?.finalDecision, 40).toLocaleUpperCase()
      && zeroViolations(run)
    ));
  });
}

export function validateTemplateEngineActivationEvidence(evidence, expectedGitSha = null) {
  const scenarios = new Set(Array.isArray(evidence?.scenarios) ? evidence.scenarios : []);
  const languages = new Set(Array.isArray(evidence?.languages) ? evidence.languages : []);
  const tenants = new Set(Array.isArray(evidence?.tenants) ? evidence.tenants : []);
  const reasons = [];
  if (evidence?.passed !== true) reasons.push('acceptance_not_passed');
  if (evidence?.productionPublishedData !== true) reasons.push('not_production_published_data');
  if (evidence?.liveFinalizedTurns !== true) reasons.push('not_live_finalized_turns');
  if (!Number.isInteger(evidence?.repeats) || evidence.repeats < 3) reasons.push('fewer_than_three_runs');
  if (tenants.size < 2) reasons.push('insufficient_tenants');
  if (languages.size < 2) reasons.push('insufficient_languages');
  if (requiredTemplateEngineScenarios.some((scenario) => !scenarios.has(scenario))) {
    reasons.push('scenario_coverage_incomplete');
  }
  if (!validScenarioRuns(
    evidence,
    requiredTemplateEngineScenarios,
    Math.max(3, Number(evidence?.repeats) || 0),
  )) {
    reasons.push('scenario_runs_incomplete');
  }
  if (!zeroViolations(evidence)) reasons.push('safety_violation_present');
  if (expectedGitSha && cleanText(evidence?.gitSha, 64) !== cleanText(expectedGitSha, 64)) {
    reasons.push('git_sha_mismatch');
  }
  return Object.freeze({
    valid: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}

function shadowResultSafe(result) {
  if (!result || typeof result !== 'object'
    || result.sideEffectsExecuted === true
    || result.toolExecuted === true
    || result.ttsExecuted === true
    || result.outputValidation?.valid !== true) return false;
  const decision = cleanText(result.decision?.decision ?? result.decision, 40).toLocaleUpperCase();
  if (!['RESPONSE', 'CLARIFY', 'TOOL', 'NO_MATCH'].includes(decision)) return false;
  if (decision === 'TOOL') return true;
  const speech = cleanText(result.speech
    || result.decision?.response
    || result.decision?.clarification?.question, 4_000);
  return Boolean(speech);
}

export function createTemplateEngineCutoverController(configuration = {}, dependencies = {}) {
  const selectedMode = mode(configuration.mode);
  const log = dependencies.log ?? { info() {}, warn() {}, error() {} };
  const executeShadowTurn = dependencies.executeShadowTurn;
  const acceptance = validateTemplateEngineActivationEvidence(
    configuration.acceptanceEvidence,
    configuration.gitSha,
  );
  if (selectedMode === templateEngineModes.ACTIVE && !acceptance.valid) {
    throw new AppError(409, 'Template engine cannot activate before live acceptance passes',
      'TEMPLATE_ENGINE_ACTIVATION_GATE_FAILED', { reasons: acceptance.reasons });
  }
  if (selectedMode === templateEngineModes.ACTIVE
    && (configuration.activeRuntimeReady !== true
      || typeof dependencies.executeActiveTurn !== 'function')) {
    throw new AppError(409, 'Template engine active path is not connected to the voice runtime',
      'TEMPLATE_ENGINE_ACTIVE_RUNTIME_NOT_READY');
  }
  const metrics = {
    observed: 0, completed: 0, matched: 0, mismatched: 0,
    failed: 0, unsafeResults: 0, samples: [],
  };

  async function observeFinalizedTurn(input = {}) {
    if (selectedMode === templateEngineModes.LEGACY) {
      return Object.freeze({ status: 'SKIPPED', mode: selectedMode });
    }
    if (typeof executeShadowTurn !== 'function') {
      metrics.failed += 1;
      log.error({ stage: 'template_engine.shadow_unavailable' },
        'Template-engine shadow runner is unavailable');
      return Object.freeze({ status: 'UNAVAILABLE', mode: selectedMode });
    }
    metrics.observed += 1;
    const request = Object.freeze({
      ...safeClone(input),
      shadow: true,
      sideEffectsAllowed: false,
    });
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve(executeShadowTurn(request)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(
            new Error('Template-engine shadow turn timed out'),
            { code: 'TEMPLATE_ENGINE_SHADOW_TIMEOUT' },
          )), boundedTimeout(configuration.timeoutMs));
          timer.unref?.();
        }),
      ]);
      if (!shadowResultSafe(result)) {
        metrics.unsafeResults += 1;
        throw Object.assign(new Error('Shadow execution attempted a caller-visible side effect'), {
          code: 'TEMPLATE_ENGINE_SHADOW_SIDE_EFFECT_REJECTED',
        });
      }
      const legacyType = cleanText(input.legacyOutcome?.decision, 40).toLocaleUpperCase();
      const shadowType = cleanText(result?.decision?.decision ?? result?.decision, 40)
        .toLocaleUpperCase();
      const comparable = Boolean(legacyType && shadowType);
      const matched = comparable && legacyType === shadowType;
      metrics.completed += 1;
      if (matched) metrics.matched += 1;
      else if (comparable) metrics.mismatched += 1;
      const sample = Object.freeze({
        callId: cleanText(input.callId, 160) || null,
        turnId: cleanText(input.turnId, 160) || null,
        legacyType: legacyType || null,
        shadowType: shadowType || null,
        matched: comparable ? matched : null,
        validation: result?.outputValidation?.reason ?? null,
      });
      if (metrics.samples.length < 100) metrics.samples.push(sample);
      log.info({ stage: 'template_engine.shadow_completed', ...sample },
        'Template-engine shadow decision completed without caller-visible effects');
      return Object.freeze({ status: 'COMPLETED', mode: selectedMode, result, sample });
    } catch (error) {
      metrics.failed += 1;
      log.warn({
        stage: 'template_engine.shadow_failed',
        code: error?.code ?? 'TEMPLATE_ENGINE_SHADOW_FAILED',
        callId: cleanText(input.callId, 160) || null,
        turnId: cleanText(input.turnId, 160) || null,
      }, 'Template-engine shadow failure did not affect the live caller path');
      return Object.freeze({
        status: 'FAILED', mode: selectedMode,
        reason: error?.code ?? 'TEMPLATE_ENGINE_SHADOW_FAILED',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    mode: selectedMode,
    acceptance,
    observeFinalizedTurn,
    executeActiveTurn: selectedMode === templateEngineModes.ACTIVE
      ? (input) => dependencies.executeActiveTurn(Object.freeze({
        ...safeClone(input), shadow: false, sideEffectsAllowed: true,
      })) : null,
    snapshot: () => Object.freeze({
      ...metrics,
      samples: Object.freeze([...metrics.samples]),
    }),
  });
}
