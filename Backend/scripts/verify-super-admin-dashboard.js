import assert from 'node:assert/strict';
import { createFixture } from './task-16-17-fixture.js';

const fixture = await createFixture(22);
try {
  const beforeResponse = await fixture.api(fixture.base, '/admin/dashboard', { headers: fixture.adminHeaders });
  assert.equal(beforeResponse.status, 200);
  const before = (await beforeResponse.json()).data;
  await fixture.company('dashboard');
  const response = await fixture.api(fixture.base, '/admin/dashboard', { headers: fixture.adminHeaders });
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.overview.activeCompanies, before.overview.activeCompanies + 1);
  assert.equal(data.callTraffic.length, 12);
  assert.ok(Array.isArray(data.outcomes));
  assert.ok(Array.isArray(data.topCompanies));
  assert.ok(Array.isArray(data.liveCalls));
  assert.equal((await fixture.api(fixture.base, '/admin/dashboard')).status, 401);
  console.log(JSON.stringify({ success: true, realDatabaseSummary: 'passed', authenticatedAccess: 'passed',
    twelveHourTraffic: 'passed', platformDataShape: 'passed' }, null, 2));
} finally {
  await fixture.cleanup();
}
