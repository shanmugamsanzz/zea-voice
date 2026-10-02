import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { createModelPricesSchema, parseProviderInput } = await import('../src/providers/provider.schemas.js');
const { createProviderModelPrices } = await import('../src/providers/provider.service.js');

const parsed = parseProviderInput(createModelPricesSchema, {
  providerId: '33333333-3333-4333-8333-333333333333',
  parameters: [
    { parameterName: 'Input Tokens', currency: 'usd', unitName: '1 million tokens', unitQuantity: 1_000_000, price: 2.5, effectiveDate: '2026-10-01' },
    { parameterName: 'Output Tokens', currency: 'USD', unitName: '1 million tokens', unitQuantity: 1_000_000, price: 10 },
    { parameterName: 'Requests', currency: 'INR', unitName: 'request', unitQuantity: 1, price: 0.25, status: 'inactive', notes: 'Optional request charge' },
  ],
});
assert.equal(parsed.success, true);
assert.equal(parsed.data.parameters[0].currency, 'USD');
assert.equal(parsed.data.parameters.length, 3);

const duplicate = parseProviderInput(createModelPricesSchema, {
  providerId: '33333333-3333-4333-8333-333333333333',
  parameters: [
    { parameterName: 'Characters', currency: 'USD', unitName: 'character', unitQuantity: 1, price: 1 },
    { parameterName: 'characters', currency: 'USD', unitName: 'character', unitQuantity: 1, price: 1 },
  ],
});
assert.equal(duplicate.success, false);
assert.ok(duplicate.issues.some((issue) => issue.field === 'parameters.1.parameterName'));
assert.equal(parseProviderInput(createModelPricesSchema, {
  providerId: '33333333-3333-4333-8333-333333333333',
  parameters: [{ parameterName: 'Minutes', currency: 'USD', unitName: 'minute', unitQuantity: 0, price: 1 }],
}).success, false);
assert.equal(parseProviderInput(createModelPricesSchema, {
  parameters: [{ parameterName: 'Minutes', currency: 'USD', unitName: 'minute', unitQuantity: 1, price: 1 }],
}).success, false);

const calls = [];
let priceId = 0;
const created = await createProviderModelPrices(
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  parsed.data,
  { contextRunner: async (_actor, operation) => operation({
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('FROM provider_models')) return { rowCount: 1, rows: [{
        id: '22222222-2222-4222-8222-222222222222', provider_id: '33333333-3333-4333-8333-333333333333',
        provider_name: 'Provider', provider_type: 'llm', runtime_connection_type: 'openai', provider_status: 'connected',
      }] };
      if (sql.includes('INSERT INTO provider_model_prices')) {
        const parameter = parsed.data.parameters[priceId++];
        return { rowCount: 1, rows: [{ id: `price-${priceId}`, provider_id: values[0], model_id: values[1],
          parameter_name: parameter.parameterName, currency: parameter.currency, unit_name: parameter.unitName,
          unit_quantity: parameter.unitQuantity, price: parameter.price, effective_date: parameter.effectiveDate ?? '2026-10-01',
          status: parameter.status, notes: parameter.notes ?? null, created_by: values[10], updated_by: values[10],
          created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }] };
      }
      if (sql.includes('INSERT INTO audit_logs')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  }) },
);
assert.equal(created.length, 3);
assert.ok(calls.filter((call) => call.sql.includes('INSERT INTO provider_model_prices')).every((call) => (
  call.values[0] === '33333333-3333-4333-8333-333333333333'
  && call.values[1] === '22222222-2222-4222-8222-222222222222'
)));
assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO audit_logs')).length, 1);

console.log(JSON.stringify({ success: true, task: 'Flexible provider model price parameter builder' }));
