import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFixture } from './task-16-17-fixture.js';

const fixture = await createFixture('admin-users');

try {
  const suffix = crypto.randomUUID().slice(0, 8);
  const companyResponse = await fixture.api(fixture.base, '/admin/companies', {
    method: 'POST', headers: fixture.adminHeaders,
    body: JSON.stringify({
      businessName: `Admin Users ${suffix}`,
      firstName: 'Admin', lastName: 'Owner',
      email: `admin-users-company-${suffix}@example.test`,
      businessPhone: '+919999999999', timezone: 'Asia/Kolkata', perMinutePrice: 5.5,
    }),
  });
  const companyPayload = await companyResponse.json();
  assert.equal(companyResponse.status, 201, JSON.stringify(companyPayload));
  const company = companyPayload.data;
  fixture.trackTenant(company.tenantId);

  const secondCompanyResponse = await fixture.api(fixture.base, '/admin/companies', {
    method: 'POST', headers: fixture.adminHeaders,
    body: JSON.stringify({
      businessName: `Admin Users Target ${suffix}`,
      firstName: 'Target', lastName: 'Owner',
      email: `admin-users-target-${suffix}@example.test`,
      businessPhone: '+918888888888', timezone: 'Asia/Kolkata', perMinutePrice: 6,
    }),
  });
  const secondCompanyPayload = await secondCompanyResponse.json();
  assert.equal(secondCompanyResponse.status, 201, JSON.stringify(secondCompanyPayload));
  const secondCompany = secondCompanyPayload.data;
  fixture.trackTenant(secondCompany.tenantId);

  const createUser = async (role, label) => {
    const response = await fixture.api(fixture.base, '/admin/developers', {
      method: 'POST', headers: fixture.adminHeaders,
      body: JSON.stringify({
        companyId: company.tenantId,
        fullName: `${label} ${suffix}`,
        email: `admin-users-${label.toLowerCase()}-${suffix}@example.test`,
        password: fixture.password,
        role,
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(payload));
    assert.equal(payload.data.role, role);
    assert.equal(payload.data.companyId, company.tenantId);
    return payload.data;
  };

  const developer = await createUser('COMPANY_DEVELOPER', 'Developer');
  const user = await createUser('COMPANY_USER', 'User');

  const allResponse = await fixture.api(
    fixture.base, `/admin/developers?companyId=${company.tenantId}&page=1&pageSize=100`,
    { headers: fixture.adminHeaders },
  );
  const allPayload = await allResponse.json();
  assert.equal(allResponse.status, 200, JSON.stringify(allPayload));
  assert.equal(allPayload.data.pagination.total, 2);

  const developersResponse = await fixture.api(
    fixture.base, `/admin/developers?companyId=${company.tenantId}&role=COMPANY_DEVELOPER&page=1&pageSize=100`,
    { headers: fixture.adminHeaders },
  );
  const developersPayload = await developersResponse.json();
  assert.equal(developersResponse.status, 200, JSON.stringify(developersPayload));
  assert.deepEqual(developersPayload.data.items.map((item) => item.id), [developer.id]);

  const updatedEmail = `admin-users-edited-${suffix}@example.test`;
  const updateUserResponse = await fixture.api(fixture.base, `/admin/developers/${user.id}`, {
    method: 'PATCH', headers: fixture.adminHeaders,
    body: JSON.stringify({
      fullName: `Edited User ${suffix}`, email: updatedEmail,
      role: 'COMPANY_DEVELOPER', companyId: secondCompany.tenantId,
    }),
  });
  const updateUserPayload = await updateUserResponse.json();
  assert.equal(updateUserResponse.status, 200, JSON.stringify(updateUserPayload));
  assert.equal(updateUserPayload.data.fullName, `Edited User ${suffix}`);
  assert.equal(updateUserPayload.data.email, updatedEmail);
  assert.equal(updateUserPayload.data.role, 'COMPANY_DEVELOPER');
  assert.equal(updateUserPayload.data.companyId, secondCompany.tenantId);

  const statusResponse = await fixture.api(fixture.base, `/admin/developers/${user.id}/status`, {
    method: 'PATCH', headers: fixture.adminHeaders, body: JSON.stringify({ status: 'suspended' }),
  });
  const statusPayload = await statusResponse.json();
  assert.equal(statusResponse.status, 200, JSON.stringify(statusPayload));
  assert.equal(statusPayload.data.status, 'suspended');

  const deleteUserResponse = await fixture.api(fixture.base, `/admin/developers/${user.id}`, {
    method: 'DELETE', headers: fixture.adminHeaders,
  });
  const deleteUserPayload = await deleteUserResponse.json();
  assert.equal(deleteUserResponse.status, 200, JSON.stringify(deleteUserPayload));
  assert.equal(deleteUserPayload.data.deleted, true);

  const remainingResponse = await fixture.api(
    fixture.base, `/admin/developers?companyId=${company.tenantId}&page=1&pageSize=100`,
    { headers: fixture.adminHeaders },
  );
  const remainingPayload = await remainingResponse.json();
  assert.equal(remainingResponse.status, 200, JSON.stringify(remainingPayload));
  assert.deepEqual(remainingPayload.data.items.map((item) => item.id), [developer.id]);

  const deleteCompanyResponse = await fixture.api(fixture.base, `/admin/companies/${company.tenantId}`, {
    method: 'DELETE', headers: fixture.adminHeaders,
  });
  const deleteCompanyPayload = await deleteCompanyResponse.json();
  assert.equal(deleteCompanyResponse.status, 200, JSON.stringify(deleteCompanyPayload));
  assert.equal(deleteCompanyPayload.data.deleted, true);

  const deletedCompanyResponse = await fixture.api(fixture.base, `/admin/companies/${company.tenantId}`, {
    headers: fixture.adminHeaders,
  });
  assert.equal(deletedCompanyResponse.status, 404);

  const deleteSecondCompanyResponse = await fixture.api(fixture.base, `/admin/companies/${secondCompany.tenantId}`, {
    method: 'DELETE', headers: fixture.adminHeaders,
  });
  assert.equal(deleteSecondCompanyResponse.status, 200);

  console.log('Super Admin company and user edit/delete verification passed.');
} finally {
  await fixture.cleanup();
}
