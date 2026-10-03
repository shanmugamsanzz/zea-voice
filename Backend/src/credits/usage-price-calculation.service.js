const moneyScale = 100_000_000;

function rounded(value) {
  return Math.round((Number(value) || 0) * moneyScale) / moneyScale;
}

function normalized(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function priceParameterKey(price = {}) {
  const value = normalized(`${price.parameterName ?? price.parameter_name ?? ''} ${price.unitName ?? price.unit_name ?? ''}`);
  if (/cached.*input/.test(value)) return 'cached_input_tokens';
  if (/audio.*input.*token/.test(value)) return 'audio_input_tokens';
  if (/audio.*output.*token/.test(value)) return 'audio_output_tokens';
  if (/input.*token/.test(value)) return 'input_tokens';
  if (/output.*token/.test(value)) return 'output_tokens';
  if (/character/.test(value)) return 'characters';
  if (/request/.test(value)) return 'requests';
  const callDirection = /inbound/.test(value) ? 'inbound' : /outbound/.test(value) ? 'outbound' : null;
  if (callDirection && /minute|min/.test(value)) return `${callDirection}_minutes`;
  if (callDirection && /second|sec/.test(value)) return `${callDirection}_seconds`;
  const direction = /audio.*input|input.*audio/.test(value) ? 'input'
    : /audio.*output|output.*audio/.test(value) ? 'output' : 'generic';
  if (/minute|min/.test(value)) return `${direction}_minutes`;
  if (/second|sec/.test(value)) return `${direction}_seconds`;
  return null;
}

function genericAudioDurationMs(event) {
  if (event.serviceType === 'stt') return Number(event.audioInputMs ?? event.audio_input_ms ?? 0);
  if (event.serviceType === 'tts') return Number(event.audioOutputMs ?? event.audio_output_ms ?? 0);
  if (event.serviceType === 'audio_to_audio') {
    return Number(event.audioInputMs ?? event.audio_input_ms ?? 0)
      + Number(event.audioOutputMs ?? event.audio_output_ms ?? 0);
  }
  const duration = Math.max(0, Number(event.durationMs ?? event.duration_ms ?? 0) || 0);
  const increment = Number(event.billingIncrementMs ?? 0);
  if (event.serviceType === 'telephony' && increment > 0 && Number.isFinite(increment)) {
    return Math.ceil(duration / increment) * increment;
  }
  return duration;
}

export function usageQuantityForParameter(event = {}, parameterKey) {
  const value = (camel, snake) => Math.max(0, Number(event[camel] ?? event[snake] ?? 0) || 0);
  if (parameterKey === 'input_tokens') return value('inputTokens', 'input_tokens');
  if (parameterKey === 'output_tokens') return value('outputTokens', 'output_tokens');
  if (parameterKey === 'cached_input_tokens') return value('cachedInputTokens', 'cached_input_tokens');
  if (parameterKey === 'audio_input_tokens') return value('audioInputTokens', 'audio_input_tokens');
  if (parameterKey === 'audio_output_tokens') return value('audioOutputTokens', 'audio_output_tokens');
  if (parameterKey === 'characters') return value('characters', 'character_count');
  if (parameterKey === 'requests') return value('requests', 'request_count');
  if (parameterKey.startsWith('inbound_') && event.direction !== 'inbound') return 0;
  if (parameterKey.startsWith('outbound_') && event.direction !== 'outbound') return 0;
  const milliseconds = parameterKey.startsWith('input_') ? value('audioInputMs', 'audio_input_ms')
    : parameterKey.startsWith('output_') ? value('audioOutputMs', 'audio_output_ms')
      : Math.max(0, genericAudioDurationMs(event) || 0);
  if (parameterKey.endsWith('_minutes')) return milliseconds / 60_000;
  if (parameterKey.endsWith('_seconds')) return milliseconds / 1_000;
  return 0;
}

function pickRate(currency, rates = []) {
  const wanted = String(currency ?? 'INR').toUpperCase();
  if (wanted === 'INR') return { id: null, currency: 'INR', inrPerUnit: 1 };
  const rate = rates.find((candidate) => String(candidate.currency).toUpperCase() === wanted);
  if (!rate) return null;
  return {
    id: rate.id ?? null,
    currency: wanted,
    inrPerUnit: Number(rate.inrPerUnit ?? rate.inr_per_unit),
  };
}

// Pure calculation layer. Database selection and persistence are deliberately
// separate so pricing can be tested without a call runtime or a provider.
export function calculateUsageCostLines(event, prices = [], exchangeRates = []) {
  const lines = [];
  const unpriced = [];
  for (const price of prices) {
    const parameterKey = priceParameterKey(price);
    if (!parameterKey) { unpriced.push({ price, reason: 'unsupported_parameter' }); continue; }
    const usageQuantity = usageQuantityForParameter(event, parameterKey);
    if (usageQuantity <= 0) continue;
    const rate = pickRate(price.currency, exchangeRates);
    if (!rate || !Number.isFinite(rate.inrPerUnit) || rate.inrPerUnit <= 0) {
      unpriced.push({ price, parameterKey, reason: 'exchange_rate_missing' });
      continue;
    }
    const unitQuantity = Number(price.unitQuantity ?? price.unit_quantity);
    const configuredPrice = Number(price.price);
    if (!Number.isFinite(unitQuantity) || unitQuantity <= 0 || !Number.isFinite(configuredPrice) || configuredPrice < 0) {
      unpriced.push({ price, parameterKey, reason: 'invalid_price_configuration' });
      continue;
    }
    const sourceCost = rounded((usageQuantity / unitQuantity) * configuredPrice);
    lines.push({
      parameterKey, usageQuantity: rounded(usageQuantity), sourceCost,
      costInr: rounded(sourceCost * rate.inrPerUnit),
      exchangeRate: rate.inrPerUnit, exchangeRateId: rate.id,
      price,
    });
  }
  return { lines, unpriced, totalInr: rounded(lines.reduce((total, line) => total + line.costInr, 0)) };
}

async function activePrices(client, event) {
  if (!event.providerId || !event.modelId) return [];
  const result = await client.query(`SELECT DISTINCT ON (lower(parameter_name)) *
    FROM provider_model_prices
    WHERE provider_id=$1 AND model_id=$2 AND status='active' AND effective_date <= $3::date
    ORDER BY lower(parameter_name), effective_date DESC, updated_at DESC, id DESC`, [
    event.providerId, event.modelId, event.occurredAt ?? event.occurred_at ?? new Date().toISOString(),
  ]);
  return result.rows;
}

async function activeExchangeRates(client, occurredAt) {
  const result = await client.query(`SELECT DISTINCT ON (currency) *
    FROM currency_exchange_rates
    WHERE status='active' AND effective_date <= $1::date
    ORDER BY currency, effective_date DESC, updated_at DESC, id DESC`, [occurredAt ?? new Date().toISOString()]);
  return result.rows;
}

export async function calculateAndPersistUsageEventCosts(client, event) {
  const [prices, exchangeRates] = await Promise.all([
    activePrices(client, event), activeExchangeRates(client, event.occurredAt ?? event.occurred_at),
  ]);
  const calculation = calculateUsageCostLines(event, prices, exchangeRates);
  const persisted = [];
  for (const line of calculation.lines) {
    const price = line.price;
    const result = await client.query(`INSERT INTO call_metered_usage_costs
      (usage_event_id,call_session_id,tenant_id,provider_model_price_id,exchange_rate_id,
       parameter_key,parameter_name,price_currency,price_unit_name,price_unit_quantity,
       configured_price,usage_quantity,source_cost,inr_exchange_rate,cost_inr,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
      ON CONFLICT (usage_event_id,parameter_key) DO NOTHING RETURNING *`, [
      event.id, event.callSessionId ?? event.call_session_id, event.tenantId ?? event.tenant_id,
      price.id, line.exchangeRateId, line.parameterKey, price.parameterName ?? price.parameter_name,
      String(price.currency).toUpperCase(), price.unitName ?? price.unit_name,
      Number(price.unitQuantity ?? price.unit_quantity), Number(price.price), line.usageQuantity,
      line.sourceCost, line.exchangeRate, line.costInr,
      JSON.stringify({ priceVersionId: price.id, exchangeRateId: line.exchangeRateId }),
    ]);
    if (result.rowCount) persisted.push(result.rows[0]);
  }
  return { ...calculation, persisted };
}
