import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
const { database } = await import('../src/infrastructure/database.js');
const { ensurePlivoPricingProvider } = await import('../src/providers/provider.service.js');
let connected = true;
let provider = null;
let model = null;
let inserts = 0;
const client = new EventEmitter();
client.release = () => {};
client.query = async (sql, values) => {
  const result = (rows) => ({ rows, rowCount: rows.length });
  if (sql.includes('FROM telephony_accounts')) return result(connected ? [{ id: 'account' }] : []);
  if (sql.includes('SELECT id FROM ai_providers')) return result(provider ? [provider] : []);
  if (sql.includes('INSERT INTO ai_providers')) {
    inserts++;
    provider = { id: 'pricing-provider', name: values[0], slug: values[1], type: 'telephony',
      runtime_connection_type: 'plivo', status: 'connected', usage_count: 0, parameter_keys: [] };
    return result([provider]);
  }
  if (sql.includes('SELECT id FROM provider_models')) return result(model ? [model] : []);
  if (sql.includes('INSERT INTO provider_models')) {
    inserts++;
    assert.equal(values[0], provider.id);
    model = { id: 'voice-model' };
    return result([model]);
  }
  if (sql.includes('SELECT p.*')) return result([{ ...provider, model_count: model ? 1 : 0 }]);
  assert.ok(/^(BEGIN|COMMIT|ROLLBACK|SELECT\s+set_config|SELECT pg_advisory_xact_lock)/.test(sql.trim()), sql);
  return result([]);
};
const originalConnect = database.connect;
database.connect = async () => client;
try {
  const first = await ensurePlivoPricingProvider('admin');
  assert.equal(first.type, 'telephony');
  assert.equal(first.modelCount, 1);
  assert.equal(inserts, 2);
  const second = await ensurePlivoPricingProvider('admin');
  assert.equal(first.id, second.id);
  assert.equal(inserts, 2, 'Repeated visits must preserve provider, model and prices');
  connected = false;
  await assert.rejects(ensurePlivoPricingProvider('admin'),
    (error) => error.code === 'PLIVO_ACCOUNT_REQUIRED');
  assert.equal(inserts, 2);
} finally {
  database.connect = originalConnect;
  await database.end();
}
console.log('Plivo pricing setup checks passed.');
