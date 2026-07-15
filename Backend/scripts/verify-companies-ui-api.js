import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFixture } from './task-16-17-fixture.js';

const fixture = await createFixture('companies-ui');
const previousTestTenants = await fixture.db.query(
  `SELECT tenant_id FROM organizations WHERE primary_email LIKE 'companies-ui-%@example.test'`,
);
for (const row of previousTestTenants.rows) fixture.trackTenant(row.tenant_id);

try {
  const suffix = crypto.randomUUID().slice(0, 8);
  const businessName = `Companies UI ${suffix}`;
  const invalidResponse = await fixture.api(fixture.base, '/admin/companies', {
    method: 'POST',
    headers: fixture.adminHeaders,
    body: JSON.stringify({ businessName, email: `invalid-${suffix}@example.test` }),
  });
  const invalidPayload = await invalidResponse.json();
  assert.equal(invalidResponse.status, 400, JSON.stringify(invalidPayload));
  const requiredFields = new Set(invalidPayload.error.details.map((issue) => issue.field));
  for (const field of ['firstName', 'lastName', 'businessPhone', 'timezone', 'perMinutePrice']) {
    assert.equal(requiredFields.has(field), true, `${field} must be required`);
  }

  const createResponse = await fixture.api(fixture.base, '/admin/companies', {
    method: 'POST',
    headers: fixture.adminHeaders,
    body: JSON.stringify({
      businessName,
      legalName: `${businessName} Private Limited`,
      firstName: 'UI',
      lastName: 'Owner',
      email: `companies-ui-${suffix}@example.test`,
      businessPhone: '+919999999999',
      website: 'https://example.test',
      billingTier: 'enterprise',
      perMinutePrice: 5.5,
      addressLine1: '1 Test Street',
      state: 'Tamil Nadu',
      country: 'India',
      postalCode: '600001',
      timezone: 'Asia/Kolkata',
      workspaceName: `${businessName} Workspace`,
      status: 'active',
      locale: 'en-US',
      currency: 'INR',
    }),
  });
  const createPayload = await createResponse.json();
  assert.equal(createResponse.status, 201, JSON.stringify(createPayload));
  const company = createPayload.data;
  fixture.trackTenant(company.tenantId);
  assert.equal(company.businessName, businessName);
  assert.equal(company.billingTier, 'enterprise');
  assert.equal(company.perMinutePrice, 5.5);
  assert.equal(company.teamSize, 0);
  assert.equal(company.phoneNumbersCount, 0);
  assert.equal(company.creditsBalance, 0);
  assert.equal(company.monthlySpend, 0);

  const updateResponse = await fixture.api(fixture.base, `/admin/companies/${company.tenantId}`, {
    method: 'PATCH', headers: fixture.adminHeaders,
    body: JSON.stringify({ firstName: 'Updated', businessPhone: '+918888888888', perMinutePrice: 6.75 }),
  });
  const updatePayload = await updateResponse.json();
  assert.equal(updateResponse.status, 200, JSON.stringify(updatePayload));
  assert.equal(updatePayload.data.firstName, 'Updated');
  assert.equal(updatePayload.data.businessPhone, '+918888888888');
  assert.equal(updatePayload.data.perMinutePrice, 6.75);

  const listResponse = await fixture.api(
    fixture.base,
    `/admin/companies?search=${encodeURIComponent(businessName)}&billingTier=enterprise&page=1&pageSize=100`,
    { headers: fixture.adminHeaders },
  );
  const listPayload = await listResponse.json();
  assert.equal(listResponse.status, 200, JSON.stringify(listPayload));
  assert.equal(listPayload.data.pagination.total, 1);
  assert.equal(listPayload.data.items[0].tenantId, company.tenantId);

  const detailResponse = await fixture.api(fixture.base, `/admin/companies/${company.tenantId}`, {
    headers: fixture.adminHeaders,
  });
  const detailPayload = await detailResponse.json();
  assert.equal(detailResponse.status, 200, JSON.stringify(detailPayload));
  assert.equal(detailPayload.data.email, `companies-ui-${suffix}@example.test`);

  const adjustmentResponse = await fixture.api(
    fixture.base,
    `/admin/credits/companies/${company.tenantId}/adjustments`,
    {
      method: 'POST',
      headers: fixture.adminHeaders,
      body: JSON.stringify({
        direction: 'credit',
        amount: 250,
        type: 'manual_adjustment',
        description: 'Companies UI verification',
      }),
    },
  );
  const adjustmentPayload = await adjustmentResponse.json();
  assert.equal(adjustmentResponse.status, 201, JSON.stringify(adjustmentPayload));
  assert.equal(adjustmentPayload.data.balance, 250);

  const refreshedResponse = await fixture.api(fixture.base, `/admin/companies/${company.tenantId}`, {
    headers: fixture.adminHeaders,
  });
  const refreshedPayload = await refreshedResponse.json();
  assert.equal(refreshedResponse.status, 200, JSON.stringify(refreshedPayload));
  assert.equal(refreshedPayload.data.creditsBalance, 250);

  console.log('Companies UI API verification passed.');
} finally {
  await fixture.db.query(
    `DELETE FROM credit_ledger_entries
     WHERE tenant_id IN (
       SELECT tenant_id FROM organizations WHERE primary_email LIKE 'companies-ui-%@example.test'
     )`,
  );
  await fixture.cleanup();
}
