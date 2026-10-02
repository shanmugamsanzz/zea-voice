import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const providerId = '33333333-3333-4333-8333-333333333333';
const modelId = '22222222-2222-4222-8222-222222222222';
const actorId = '11111111-1111-4111-8111-111111111111';

const { createModelPricesSchema, parseProviderInput, updateModelPriceSchema } = await import('../src/providers/provider.schemas.js');
const { createProviderModelPrices } = await import('../src/providers/provider.service.js');
const routes = await fs.readFile(new URL('../src/providers/provider.routes.js', import.meta.url), 'utf8');

function validPricing(parameters) {
  return parseProviderInput(createModelPricesSchema, { providerId, parameters });
}

// LLM token-based pricing.
assert.equal(validPricing([
  { parameterName: 'Input Tokens', currency: 'USD', unitName: 'tokens', unitQuantity: 1_000_000, price: 2.5 },
  { parameterName: 'Output Tokens', currency: 'USD', unitName: 'tokens', unitQuantity: 1_000_000, price: 10 },
]).success, true);

// STT supports both minute and character billing.
assert.equal(validPricing([
  { parameterName: 'Minutes', currency: 'INR', unitName: 'minutes', unitQuantity: 1, price: 7.2 },
  { parameterName: 'Characters', currency: 'USD', unitName: 'characters', unitQuantity: 1_000_000, price: 18 },
]).success, true);

// TTS supports both character and minute billing.
assert.equal(validPricing([
  { parameterName: 'Characters', currency: 'USD', unitName: 'characters', unitQuantity: 1_000_000, price: 30 },
  { parameterName: 'Minutes', currency: 'USD', unitName: 'minutes', unitQuantity: 1, price: 0.15 },
]).success, true);

// Audio-to-audio supports separate input and output audio rates.
assert.equal(validPricing([
  { parameterName: 'Audio Input', currency: 'USD', unitName: 'audio tokens', unitQuantity: 1_000_000, price: 32 },
  { parameterName: 'Audio Output', currency: 'USD', unitName: 'audio tokens', unitQuantity: 1_000_000, price: 64 },
]).success, true);

// Invalid values never reach the service layer.
assert.equal(validPricing([{ parameterName: 'Minutes', currency: 'USD', unitName: 'minutes', unitQuantity: 0, price: 1 }]).success, false);
assert.equal(validPricing([{ parameterName: 'Minutes', currency: 'USD', unitName: 'minutes', unitQuantity: 1, price: -0.01 }]).success, false);
assert.equal(parseProviderInput(updateModelPriceSchema, { price: -1 }).success, false);
assert.equal(parseProviderInput(updateModelPriceSchema, { unitQuantity: 0 }).success, false);

// A price cannot be saved against a model from another provider.
await assert.rejects(
  createProviderModelPrices(actorId, modelId, validPricing([
    { parameterName: 'Requests', currency: 'USD', unitName: 'requests', unitQuantity: 1, price: 0.01 },
  ]).data, {
    contextRunner: async (_actor, operation) => operation({
      async query(sql) {
        if (sql.includes('FROM provider_models')) {
          return { rowCount: 1, rows: [{ id: modelId, provider_id: '44444444-4444-4444-8444-444444444444' }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    }),
  }),
  (error) => error?.code === 'MODEL_PROVIDER_MISMATCH',
);

// Super Admin route coverage: create, list, version-update, status change, and history.
for (const route of [
  "providerRouter.post('/models/:modelId/prices'",
  "providerRouter.get('/models/:modelId/prices'",
  "providerRouter.patch('/model-prices/:priceId'",
  "providerRouter.patch('/model-prices/:priceId/status'",
  "providerRouter.get('/models/:modelId/prices/history'",
]) assert.ok(routes.includes(route), `Missing price API route: ${route}`);

console.log(JSON.stringify({
  success: true,
  task: 'Provider model price assignment API verification',
  coverage: ['llm_tokens', 'stt_minutes_characters', 'tts_characters_minutes', 'audio_input_output', 'provider_model_isolation', 'invalid_values'],
}));
