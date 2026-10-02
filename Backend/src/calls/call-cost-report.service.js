const number = (value) => Number(value ?? 0) || 0;

function eventUsage(row) {
  return {
    inputTokens: number(row.input_tokens), outputTokens: number(row.output_tokens),
    cachedInputTokens: number(row.cached_input_tokens), audioInputTokens: number(row.audio_input_tokens),
    audioOutputTokens: number(row.audio_output_tokens), audioInputMs: number(row.audio_input_ms),
    audioOutputMs: number(row.audio_output_ms), characters: number(row.character_count),
    durationMs: number(row.duration_ms), requests: number(row.request_count),
  };
}

function money(value) { return Math.round(number(value) * 100_000_000) / 100_000_000; }

export async function getCallCostReport(client, call) {
  const result = await client.query(`SELECT u.*,
      COALESCE(jsonb_agg(jsonb_build_object(
        'id',cost.id,'parameterKey',cost.parameter_key,'parameterName',cost.parameter_name,
        'priceVersionId',cost.provider_model_price_id,'currency',cost.price_currency,
        'unitName',cost.price_unit_name,'unitQuantity',cost.price_unit_quantity,
        'configuredPrice',cost.configured_price,'usageQuantity',cost.usage_quantity,
        'sourceCost',cost.source_cost,'exchangeRateId',cost.exchange_rate_id,
        'inrExchangeRate',cost.inr_exchange_rate,'costInr',cost.cost_inr,
        'calculatedAt',cost.calculated_at
      ) ORDER BY cost.calculated_at) FILTER (WHERE cost.id IS NOT NULL),'[]'::jsonb) AS cost_lines
    FROM call_metered_usage_events u
    LEFT JOIN call_metered_usage_costs cost ON cost.usage_event_id=u.id
    WHERE u.call_session_id=$1
    GROUP BY u.id ORDER BY u.occurred_at ASC,u.created_at ASC`, [call.id]);
  const groups = new Map();
  const totals = {
    totalCostInr: 0, totalLlmTokens: 0, toolRelatedLlmTokens: 0,
    llmInputTokens: 0, llmOutputTokens: 0, llmCachedInputTokens: 0,
    llmAudioInputTokens: 0, llmAudioOutputTokens: 0,
    sttAudioMinutes: 0, sttCharacters: 0, ttsAudioMinutes: 0, ttsCharacters: 0,
    telephonyMinutes: 0,
  };
  for (const row of result.rows) {
    const usage = eventUsage(row);
    const costs = Array.isArray(row.cost_lines) ? row.cost_lines : [];
    const key = [row.service_type, row.provider_id ?? '', row.model_id ?? ''].join(':');
    const group = groups.get(key) ?? {
      serviceType: row.service_type, providerId: row.provider_id, providerName: row.provider_name,
      modelId: row.model_id, modelKey: row.model_key, modelCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, audioInputTokens: 0,
        audioOutputTokens: 0, audioInputMs: 0, audioOutputMs: 0, characters: 0, durationMs: 0, requests: 0 },
      costInr: 0, priceParameters: [],
    };
    group.modelCalls += number(row.model_call_count || 1);
    for (const [field, value] of Object.entries(usage)) group.usage[field] += value;
    for (const cost of costs) {
      const line = { ...cost, unitQuantity: number(cost.unitQuantity), configuredPrice: number(cost.configuredPrice),
        usageQuantity: number(cost.usageQuantity), sourceCost: number(cost.sourceCost),
        inrExchangeRate: number(cost.inrExchangeRate), costInr: money(cost.costInr) };
      group.priceParameters.push(line); group.costInr += line.costInr; totals.totalCostInr += line.costInr;
    }
    groups.set(key, group);
    if (row.service_type === 'llm') {
      const tokenTotal = usage.inputTokens + usage.outputTokens;
      totals.totalLlmTokens += tokenTotal;
      totals.llmInputTokens += usage.inputTokens; totals.llmOutputTokens += usage.outputTokens;
      totals.llmCachedInputTokens += usage.cachedInputTokens;
      totals.llmAudioInputTokens += usage.audioInputTokens; totals.llmAudioOutputTokens += usage.audioOutputTokens;
      if (/tool/i.test(String(row.raw_usage?.stage ?? ''))) totals.toolRelatedLlmTokens += tokenTotal;
    }
    if (row.service_type === 'stt') {
      totals.sttAudioMinutes += usage.audioInputMs / 60_000; totals.sttCharacters += usage.characters;
    }
    if (row.service_type === 'tts') {
      totals.ttsAudioMinutes += usage.audioOutputMs / 60_000; totals.ttsCharacters += usage.characters;
    }
    if (row.service_type === 'telephony') totals.telephonyMinutes += usage.durationMs / 60_000;
  }
  const durationMinutes = Math.max(0, number(call.duration_seconds) / 60);
  const billing = call.provider_metadata?.creditBilling ?? {};
  return {
    currency: 'INR', creditValueInr: 1,
    totalCostInr: money(totals.totalCostInr), totalCreditsUsed: number(call.credits_charged),
    pricePerMinuteInr: durationMinutes ? money(totals.totalCostInr / durationMinutes) : 0,
    creditBalanceAfterCall: billing.availableCreditsAfterCharge ?? null,
    totalModelsServicesUsed: groups.size, totalLlmTokens: totals.totalLlmTokens,
    toolRelatedLlmTokens: totals.toolRelatedLlmTokens,
    llm: {
      inputTokens: totals.llmInputTokens, outputTokens: totals.llmOutputTokens,
      cachedInputTokens: totals.llmCachedInputTokens, audioInputTokens: totals.llmAudioInputTokens,
      audioOutputTokens: totals.llmAudioOutputTokens,
    },
    stt: { audioMinutes: money(totals.sttAudioMinutes), characters: totals.sttCharacters },
    tts: { audioMinutes: money(totals.ttsAudioMinutes), characters: totals.ttsCharacters },
    telephony: { minutes: money(totals.telephonyMinutes) },
    providerModelBreakdown: [...groups.values()].map((group) => ({
      ...group, costInr: money(group.costInr),
      usage: Object.fromEntries(Object.entries(group.usage).map(([key, value]) => [key, money(value)])),
    })),
  };
}
