import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../migrations/1788300000000_provider-model-pricing.js', import.meta.url), 'utf8');

assert.match(migration, /CREATE TABLE provider_model_prices/u);
assert.match(migration, /provider_id uuid NOT NULL/u);
assert.match(migration, /model_id uuid NOT NULL/u);
assert.match(migration, /parameter_name varchar\(120\) NOT NULL/u);
assert.match(migration, /currency char\(3\) NOT NULL/u);
assert.match(migration, /unit_name varchar\(120\) NOT NULL/u);
assert.match(migration, /unit_quantity numeric\(24, 8\) NOT NULL/u);
assert.match(migration, /price numeric\(24, 8\) NOT NULL/u);
assert.match(migration, /effective_date date NOT NULL/u);
assert.match(migration, /status IN \('active', 'inactive'\)/u);
assert.match(migration, /updated_by uuid REFERENCES users/u);
assert.match(migration, /FOREIGN KEY \(model_id, provider_id\)/u);
assert.match(migration, /ENABLE ROW LEVEL SECURITY/u);
assert.match(migration, /provider_model_prices_admin_policy/u);
assert.match(migration, /does not calculate call cost/u);

console.log(JSON.stringify({ success: true, task: 'Provider model pricing data structure' }));
