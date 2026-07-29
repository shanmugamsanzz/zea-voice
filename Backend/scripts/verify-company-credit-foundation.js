import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompanySchema, updateCompanySchema } from '../src/companies/company.schemas.js';
import { adjustCreditsSchema, allocateCreditsSchema } from '../src/credits/credit.schemas.js';

const company = {
  businessName: 'Credit Test Company',
  organizationName: 'Credit Test Organization',
  firstName: 'Credit',
  lastName: 'Tester',
  email: 'credit-test@example.com',
  businessPhone: '+919999999999',
  perMinutePrice: 7,
  timezone: 'Asia/Kolkata',
};

assert.equal(createCompanySchema.safeParse(company).success, true);
assert.equal(createCompanySchema.safeParse({ ...company, perMinutePrice: 0 }).success, false);
assert.equal(updateCompanySchema.safeParse({ perMinutePrice: 7.5 }).success, true);
assert.equal(updateCompanySchema.safeParse({ perMinutePrice: 0 }).success, false);

assert.equal(allocateCreditsSchema.safeParse({ amount: '10000' }).success, true);
assert.equal(allocateCreditsSchema.safeParse({ amount: '10000.50' }).success, true);
assert.equal(adjustCreditsSchema.safeParse({
  direction: 'credit', amount: '5', description: 'Approved test adjustment',
}).success, true);
assert.equal(adjustCreditsSchema.safeParse({
  direction: 'credit', amount: '5.5', description: 'Invalid fractional adjustment',
}).success, false);

const migrationNames = [
  '1786000000000_company-wallet-credit-units.js',
  '1786100000000_company-credit-price-per-minute.js',
  '1786200000000_call-credit-billing.js',
  '1786300000000_company-credit-accounting-foundation.js',
  '1786400000000_global-credit-threshold-and-call-reservations.js',
];
const migrations = await Promise.all(migrationNames.map((name) =>
  readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')));

assert.match(migrations[0], /unit varchar\(24\).*'credit'/s);
assert.match(migrations[1], /per_minute_price numeric\(12, 4\)/);
assert.match(migrations[2], /credit_ledger_entries_usage_call_unique/);
assert.match(migrations[3], /company_credit_price_history/);
assert.match(migrations[3], /company_credit_payments/);
assert.match(migrations[3], /inr_remainder/);
assert.match(migrations[3], /company_credit_wallets_balance_whole/);
assert.match(migrations[3], /credit_amount bigint/);
assert.match(migrations[3], /company_credit_payments_admin_policy/);
assert.match(migrations[3], /company_credit_payments_tenant_idempotency_unique/);
assert.match(migrations[4], /platform_credit_settings/);
assert.match(migrations[4], /credit_billing_finalized/);

const creditService = await readFile(new URL('../src/credits/credit.service.js', import.meta.url), 'utf8');
assert.match(creditService, /convertPaymentToCredits/);
assert.match(creditService, /INSERT INTO company_credit_payments/);
assert.match(creditService, /IDEMPOTENCY_KEY_CONFLICT/);
assert.match(creditService, /previewCompanyCreditPurchase/);
assert.doesNotMatch(creditService.slice(creditService.indexOf('export function getTenantCredits'),
  creditService.indexOf('export function hasAvailableCompanyCredits')), /platform_pricing_rates|inrRemainder|perMinutePrice/);

console.log('Company pricing, wallet and ledger foundations verified successfully.');
