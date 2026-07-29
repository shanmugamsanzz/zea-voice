import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { finalizeCallCreditBilling } from '../src/credits/call-credit.service.js';

function baseCall(overrides = {}) {
  return {
    id: 'call-1', tenant_id: 'tenant-a', direction: 'inbound', reserved_credits: 1,
    credits_charged: 0, credit_price_snapshot_inr: '7', credit_billing_finalized: false,
    ...overrides,
  };
}

const walletRow = {
  wallet_id: 'wallet-a', balance: '10', reserved_balance: '1', available_credits: '9',
  per_minute_price: '7', low_credit_threshold: '50',
};

const zeroQueries = [];
const zero = await finalizeCallCreditBilling({
  query: async (sql) => {
    zeroQueries.push(sql);
    if (/FROM credit_ledger_entries/.test(sql)) return { rowCount: 0, rows: [] };
    if (/SELECT w\.id AS wallet_id/.test(sql)) return { rowCount: 1, rows: [walletRow] };
    if (/UPDATE company_credit_wallets/.test(sql)) return {
      rowCount: 1, rows: [{ balance: '10', reserved_balance: '0', available_balance: '10' }],
    };
    return { rowCount: 1, rows: [] };
  },
}, { call: baseCall(), durationSeconds: 0 });
assert.equal(zero.creditsCharged, 0);
assert.equal(zeroQueries.some((sql) => /INSERT INTO credit_ledger_entries/.test(sql)), false);
assert.equal(zeroQueries.some((sql) => /reserved_balance=GREATEST/.test(sql)), true);

const duplicateQueries = [];
const duplicate = await finalizeCallCreditBilling({
  query: async (sql) => {
    duplicateQueries.push(sql);
    if (/FROM credit_ledger_entries/.test(sql)) {
      return { rowCount: 1, rows: [{ credit_amount: '2', amount: '2' }] };
    }
    if (/SELECT w\.id AS wallet_id/.test(sql)) return { rowCount: 1, rows: [walletRow] };
    return { rowCount: 1, rows: [] };
  },
}, { call: baseCall(), durationSeconds: 61 });
assert.equal(duplicate.idempotent, true);
assert.equal(duplicate.creditsCharged, 2);
assert.equal(duplicateQueries.some((sql) => /SET balance=balance-/.test(sql)), false);
assert.equal(duplicateQueries.some((sql) => /INSERT INTO credit_ledger_entries/.test(sql)), false);

const [migration, creditRuntime, callStore, tenantCredits, dashboard, companyUi, layoutUi] = await Promise.all([
  readFile(new URL('../migrations/1786400000000_global-credit-threshold-and-call-reservations.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/credits/call-credit.service.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/voice/call-session-store.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/credits/credit.service.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/dashboard/dashboard.service.js', import.meta.url), 'utf8'),
  readFile(new URL('../../Frontend/src/components/views/CompanyViews.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../Frontend/src/components/layouts/DashboardLayouts.tsx', import.meta.url), 'utf8'),
]);

assert.match(creditRuntime, /WHERE w\.tenant_id=\$1/);
assert.match(creditRuntime, /FOR UPDATE OF w/);
assert.match(creditRuntime, /\$4::bigint,\$4::bigint/);
assert.match(callStore, /pg_advisory_xact_lock/);
assert.match(migration, /call_sessions_pending_credit_billing_idx/);
assert.match(migration, /call_sessions_finalized_reservation_released/);
assert.match(migration, /company_credit_wallets_auth_service_select_policy/);
assert.match(migration, /credit_ledger_entries_auth_service_usage_policy/);

const tenantResponseBlock = tenantCredits.slice(tenantCredits.indexOf('export function getTenantCredits'),
  tenantCredits.indexOf('export function hasAvailableCompanyCredits'));
assert.doesNotMatch(tenantResponseBlock, /inrRemainder|perMinutePrice|paymentAmountInr/);
assert.match(tenantResponseBlock, /globalLowCreditThreshold/);
assert.match(tenantResponseBlock, /creditStatus/);
assert.doesNotMatch(dashboard.slice(dashboard.indexOf('resources:'), dashboard.indexOf('callVolume:')),
  /currency|perMinutePrice|inrRemainder/);

assert.match(companyUi, /Available Credits/);
assert.match(companyUi, /creditStatus/);
assert.match(companyUi, /role === 'USER'/);
assert.match(layoutUi, /role === 'SUPER_ADMIN'/);
assert.match(layoutUi, /No call credits are available/);
assert.match(layoutUi, /Outbound calls are paused/);

console.log('Developer/User credit visibility, tenant isolation and billing rollout hardening verified successfully.');
