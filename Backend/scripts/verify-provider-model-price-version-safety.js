import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const migration = await fs.readFile(
  new URL('../migrations/1788400000000_provider-model-price-version-safety.js', import.meta.url),
  'utf8',
);
const service = await fs.readFile(
  new URL('../src/providers/provider.service.js', import.meta.url),
  'utf8',
);

assert.match(migration, /provider_model_prices_one_active_period_unique/u);
assert.match(migration, /WHERE status = 'active'/u);
assert.match(migration, /zea_provider_model_prices_keep_rate_history/u);
assert.match(migration, /immutable; create a new price version/u);
assert.match(service, /MODEL_PROVIDER_MISMATCH/u);
assert.match(service, /ACTIVE_PRICE_PERIOD_EXISTS/u);
assert.match(service, /PROVIDER_MODEL_PRICE_VERSION_CREATED/u);
assert.match(service, /INSERT INTO provider_model_prices/u);

console.log(JSON.stringify({ success: true, task: 'Provider model price validation and version safety' }));
