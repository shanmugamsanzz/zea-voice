import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const { finalizeCallCreditBilling } = await import('../src/credits/call-credit.service.js');
const { isTelephonyMeteredCall, persistTelephonyUsage } = await import('../src/voice/call-completion.service.js');

assert.equal(isTelephonyMeteredCall({ telephony_account_id: 'plivo-1',
  provider_metadata: { source: 'browser_test' } }), false);
assert.equal(isTelephonyMeteredCall({ telephony_account_id: 'plivo-1',
  provider_metadata: { source: 'plivo' } }), true);
const { getCallCostReport } = await import('../src/calls/call-cost-report.service.js');

let telephonyCost = null;
await persistTelephonyUsage({ query: async (sql, values) => {
  if (sql.includes('FROM telephony_accounts')) {
    throw new Error('Runtime transaction cannot read admin-only telephony accounts');
  }
  if (sql.includes('INSERT INTO call_metered_usage_events')) {
    assert.equal(values[6], 120000);
    return { rowCount: 1, rows: [{ id: 'telephony-event' }] };
  }
  if (sql.includes('FROM provider_model_prices')) return { rows: [{ id: 'voice-price',
    parameter_name: 'Voice Minutes', currency: 'INR', unit_name: 'minute', unit_quantity: 1, price: 0.38 }] };
  if (sql.includes('FROM currency_exchange_rates')) return { rows: [] };
  if (sql.includes('INSERT INTO call_metered_usage_costs')) {
    telephonyCost = values[14];
    return { rowCount: 1, rows: [{}] };
  }
  throw new Error(`Unexpected query: ${sql}`);
} }, { id: 'phone-call', tenant_id: 'tenant', telephony_account_id: 'account', direction: 'inbound' },
120, new Date('2026-10-02T10:00:00Z'), {
  providerContext: async (actor, operation) => {
    assert.equal(actor, null);
    return operation({ query: async (sql, values) => {
      assert.ok(sql.includes('lower(p.runtime_connection_type)=lower(account.provider)'));
      assert.deepEqual(values, ['account']);
      return { rowCount: 1, rows: [{ provider_id: 'pricing-provider', provider_name: 'Plivo Telephony Pricing',
        model_id: 'voice-model', model_key: 'plivo-voice' }] };
    } });
  },
});
assert.equal(telephonyCost, 0.76);
await persistTelephonyUsage({ query: () => { throw new Error('Browser calls must not incur telephony usage'); } },
{ telephony_account_id: 'account', provider_metadata: { source: 'browser_test' } }, 120, new Date());

const queries = [];
const billing = await finalizeCallCreditBilling({
  query: async (sql, values) => {
    queries.push({ sql, values });
    if (/FROM credit_ledger_entries/.test(sql)) return { rowCount: 0, rows: [] };
    if (/FROM call_metered_usage_costs/.test(sql)) return { rowCount: 1, rows: [{ total_cost_inr: '2.75', cost_line_count: 3 }] };
    if (/SELECT w\.id AS wallet_id/.test(sql)) return { rowCount: 1, rows: [{
      wallet_id: 'wallet-1', balance: '50', reserved_balance: '1', available_credits: '49', low_credit_threshold: '10',
    }] };
    if (/UPDATE company_credit_wallets/.test(sql)) return { rowCount: 1, rows: [{ balance: '47.25', reserved_balance: '0', available_balance: '47.25' }] };
    return { rowCount: 1, rows: [] };
  },
}, {
  call: { id: 'call-1', tenant_id: 'tenant-1', reserved_credits: 1, credit_billing_finalized: false },
  durationSeconds: 999,
});
assert.equal(billing.creditsCharged, 2.75);
assert.equal(billing.availableCredits, 47.25);
const debit = queries.find(({ sql }) => /INSERT INTO credit_ledger_entries/.test(sql));
assert.ok(debit, 'one usage debit must be created');
assert.equal(debit.values[2], 2.75);
assert.equal(debit.values[4], 'call-1');
assert.equal(queries.some(({ sql }) => /durationSeconds/.test(sql)), false);

const browserQueries = [];
const browserBilling = await finalizeCallCreditBilling({
  query: async (sql, values) => {
    browserQueries.push({ sql, values });
    if (/FROM credit_ledger_entries/.test(sql)) return { rowCount: 0, rows: [] };
    if (/FROM call_metered_usage_costs/.test(sql)) return {
      rowCount: 1, rows: [{ total_cost_inr: '0.125', cost_line_count: 3 }],
    };
    if (/SELECT w\.id AS wallet_id/.test(sql)) return { rowCount: 1, rows: [{
      wallet_id: 'wallet-browser', balance: '10', reserved_balance: '0',
      available_credits: '10', low_credit_threshold: '1',
    }] };
    if (/UPDATE company_credit_wallets/.test(sql)) return { rowCount: 1, rows: [{
      balance: '9.875', reserved_balance: '0', available_balance: '9.875',
    }] };
    return { rowCount: 1, rows: [] };
  },
}, {
  call: { id: 'browser-call-1', tenant_id: 'tenant-1', reserved_credits: 0,
    credit_billing_finalized: false, provider_metadata: { source: 'browser_test' } },
  durationSeconds: 120,
});
assert.equal(browserBilling.creditsCharged, 0.125);
assert.equal(browserBilling.availableCredits, 9.875);
assert.equal(browserQueries.filter(({ sql }) => /INSERT INTO credit_ledger_entries/.test(sql)).length, 1);

let replayQueries = 0;
const replay = await finalizeCallCreditBilling({
  query: async () => { replayQueries += 1; throw new Error('A finalized call must not query or debit again'); },
}, { call: { id: 'call-1', tenant_id: 'tenant-1', credit_billing_finalized: true, credits_charged: '2.75' } });
assert.equal(replay.idempotent, true);
assert.equal(replay.creditsCharged, 2.75);
assert.equal(replayQueries, 0);

const report = await getCallCostReport({
  query: async () => ({ rows: [{
    id: 'event-1', service_type: 'llm', provider_id: 'provider-1', provider_name: 'OpenAI', model_id: 'model-1', model_key: 'gpt-test',
    model_call_count: 2, input_tokens: '100', output_tokens: '20', cached_input_tokens: '10', audio_input_tokens: '5', audio_output_tokens: '2',
    audio_input_ms: '0', audio_output_ms: '0', character_count: '0', duration_ms: '0', request_count: '2', raw_usage: { stage: 'tool_result_follow_up' },
    cost_lines: [{ id: 'cost-1', parameterKey: 'input_tokens', parameterName: 'Input Tokens', priceVersionId: 'price-1', currency: 'USD', unitName: '1 million tokens', unitQuantity: '1000000', configuredPrice: '2', usageQuantity: '100', sourceCost: '0.0002', exchangeRateId: 'rate-1', inrExchangeRate: '80', costInr: '0.016', calculatedAt: '2026-10-02T00:00:00Z' }],
  }, {
    id: 'event-2', service_type: 'telephony', provider_id: 'plivo-1', provider_name: 'Plivo', model_id: 'plivo-model', model_key: 'inbound',
    model_call_count: 1, input_tokens: '0', output_tokens: '0', cached_input_tokens: '0', audio_input_tokens: '0', audio_output_tokens: '0',
    audio_input_ms: '0', audio_output_ms: '0', character_count: '0', duration_ms: '120000', request_count: '1', raw_usage: {},
    cost_lines: [{ id: 'cost-2', parameterKey: 'inbound_minutes', parameterName: 'Inbound Minutes', priceVersionId: 'price-2', currency: 'INR', unitName: 'per minute', unitQuantity: '1', configuredPrice: '1', usageQuantity: '2', sourceCost: '2', exchangeRateId: null, inrExchangeRate: '1', costInr: '2', calculatedAt: '2026-10-02T00:00:00Z' }],
  }] }),
}, {
  id: 'call-1', duration_seconds: 120, credits_charged: '2.016', provider_metadata: { creditBilling: { availableCreditsAfterCharge: 47.984 } },
});
assert.equal(report.totalCostInr, 2.016);
assert.equal(report.pricePerMinuteInr, 1.008);
assert.equal(report.totalCreditsUsed, 2.016);
assert.equal(report.totalModelsServicesUsed, 2);
assert.equal(report.totalLlmTokens, 120);
assert.equal(report.toolRelatedLlmTokens, 120);
assert.equal(report.telephony.minutes, 2);
assert.equal(report.providerModelBreakdown[0].priceParameters[0].priceVersionId, 'price-1');

const [migration, completion, frontend] = await Promise.all([
  fs.readFile(new URL('../migrations/1788900000000_metered-call-credit-debits.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../src/voice/call-completion.service.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../../Frontend/src/components/reports/DeveloperReportsView.tsx', import.meta.url), 'utf8'),
]);
assert.match(migration, /credits_charged TYPE numeric\(24, 8\)/u);
assert.match(completion, /persistTelephonyUsage/u);
assert.match(completion, /type='telephony'/u);
assert.match(frontend, /Call Cost/u);
assert.match(frontend, /Saved price versions and exchange rates/u);

console.log(JSON.stringify({ success: true, task: 'Metered credit deduction and detailed call-cost reports' }));
