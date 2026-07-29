import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { creditThresholdSchema } from '../src/credits/credit.schemas.js';
import { finalizeCallCreditBilling, reserveTenantCallCredit } from '../src/credits/call-credit.service.js';

assert.equal(creditThresholdSchema.safeParse({ lowCreditThreshold: 50 }).success, true);
assert.equal(creditThresholdSchema.safeParse({ lowCreditThreshold: -1 }).success, false);
assert.equal(creditThresholdSchema.safeParse({ lowCreditThreshold: 1.5 }).success, false);

const snapshotRow = {
  wallet_id: 'wallet-1', balance: '60', reserved_balance: '0', available_credits: '60',
  per_minute_price: '7.0000', low_credit_threshold: '50',
};
const reserveQueries = [];
const reservation = await reserveTenantCallCredit({
  query: async (sql, values) => {
    reserveQueries.push({ sql, values });
    if (/SELECT w\.id AS wallet_id/.test(sql)) return { rowCount: 1, rows: [snapshotRow] };
    return { rowCount: 1, rows: [] };
  },
}, { tenantId: 'tenant-1', direction: 'outbound' });
assert.equal(reservation.reservedCredits, 1);
assert.equal(reservation.availableCreditsAfterReservation, 59);
assert.equal(reserveQueries.some(({ sql }) => /reserved_balance=reserved_balance\+1/.test(sql)), true);

await assert.rejects(reserveTenantCallCredit({
  query: async () => ({ rowCount: 1, rows: [{ ...snapshotRow, available_credits: '50' }] }),
}, { tenantId: 'tenant-1', direction: 'outbound' }),
(error) => error.code === 'COMPANY_LOW_CREDIT_OUTBOUND_BLOCKED');

const finalQueries = [];
const billing = await finalizeCallCreditBilling({
  query: async (sql, values) => {
    finalQueries.push({ sql, values });
    if (/FROM credit_ledger_entries/.test(sql)) return { rowCount: 0, rows: [] };
    if (/SELECT w\.id AS wallet_id/.test(sql)) return { rowCount: 1, rows: [snapshotRow] };
    if (/UPDATE company_credit_wallets/.test(sql)) return {
      rowCount: 1, rows: [{ balance: '57', reserved_balance: '0', available_balance: '57' }],
    };
    return { rowCount: 1, rows: [] };
  },
}, {
  call: {
    id: 'call-1', tenant_id: 'tenant-1', direction: 'inbound', reserved_credits: 1,
    credit_price_snapshot_inr: '7', credit_billing_finalized: false,
  },
  durationSeconds: 121,
});
assert.equal(billing.creditsCharged, 3);
assert.equal(finalQueries.some(({ sql }) => /entry_type,direction/.test(sql)), true);
assert.equal(finalQueries.some(({ sql }) => /\$4::bigint,\$4::bigint/.test(sql)), true);
assert.equal(finalQueries.some(({ sql }) => /credit_billing_finalized=true/.test(sql)), true);

const migration = await readFile(new URL('../migrations/1786400000000_global-credit-threshold-and-call-reservations.js', import.meta.url), 'utf8');
assert.match(migration, /platform_credit_settings/);
assert.match(migration, /reserved_credits/);
assert.match(migration, /credit_billing_finalized/);
assert.match(migration, /company_credit_wallets_auth_service_update_policy/);
assert.match(migration, /company_credit_wallets_auth_service_select_policy/);
assert.match(migration, /organizations_auth_service_credit_select_policy/);
assert.match(migration, /credit_ledger_entries_auth_service_select_policy/);

console.log('Global threshold, atomic reservation and exact-once call deduction verified successfully.');
