import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const migration = await fs.readFile(new URL('../migrations/1788500000000_retire-company-per-minute-billing.js', import.meta.url), 'utf8');
const companySchemas = await fs.readFile(new URL('../src/companies/company.schemas.js', import.meta.url), 'utf8');
const callBilling = await fs.readFile(new URL('../src/credits/call-credit.service.js', import.meta.url), 'utf8');
const creditRules = await fs.readFile(new URL('../src/credits/credit-billing-rules.js', import.meta.url), 'utf8');

assert.match(migration, /DROP COLUMN IF EXISTS per_minute_price/u);
assert.match(migration, /DROP TABLE IF EXISTS company_credit_price_history/u);
assert.doesNotMatch(companySchemas, /perMinutePrice/u);
assert.doesNotMatch(callBilling, /calculateCallCharge|creditsForConnectedDuration/u);
assert.doesNotMatch(callBilling, /INSERT INTO credit_ledger_entries/u);
assert.match(callBilling, /metered_usage_pending/u);
assert.match(creditRules, /creditValueInr/u);
assert.doesNotMatch(creditRules, /perMinutePrice/u);

console.log(JSON.stringify({ success: true, task: 'Retire company per-minute billing' }));
