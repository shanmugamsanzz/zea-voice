import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { convertPaymentToCredits } = await import('../src/credits/credit-billing-rules.js');
const { createProviderSchema, parseProviderInput } = await import('../src/providers/provider.schemas.js');
const migration = await fs.readFile(new URL('../migrations/1788600000000_decimal-credit-values-and-telephony-pricing.js', import.meta.url), 'utf8');

assert.deepEqual(convertPaymentToCredits({ paymentAmount: '100' }), {
  credits: 100,
  paymentAmount: '100',
  previousRemainderAmount: '0',
  totalAvailableAmount: '100',
  consumedAmount: '100',
  remainderAmount: '0',
  creditValueInr: '1',
});
assert.equal(convertPaymentToCredits({ paymentAmount: '0.00000001' }).credits, 0.00000001);

const telephony = parseProviderInput(createProviderSchema, {
  name: 'Plivo Usage Pricing', type: 'telephony', runtimeConnectionType: 'plivo', status: 'disconnected', parameters: [],
});
assert.equal(telephony.success, true);
assert.equal(telephony.data.type, 'telephony');
assert.match(migration, /ADD VALUE IF NOT EXISTS 'telephony'/u);
assert.match(migration, /numeric\(24, 8\)/u);

console.log(JSON.stringify({ success: true, task: 'Decimal credits and telephony pricing' }));
