import assert from 'node:assert/strict';
import { companyTabs, assertRequestTabAccess, hasTabAccess } from '../src/auth/tab-access.js';
import { createDeveloperSchema, updateDeveloperSchema } from '../src/developers/developer.schemas.js';

const auth = { role: 'COMPANY_DEVELOPER', authType: 'session', tabAccess: ['reports'] };
const request = (baseUrl, path = '/', method = 'GET', actor = auth) => ({ baseUrl, path, method, auth: actor });
for (const tab of companyTabs) {
  assert.equal(hasTabAccess({ ...auth, tabAccess: null }, tab), true);
  assert.equal(hasTabAccess({ ...auth, tabAccess: [] }, tab), false);
  assert.equal(hasTabAccess({ ...auth, role: 'SUPER_ADMIN', tabAccess: [] }, tab), true);
}
assert.doesNotThrow(() => assertRequestTabAccess(request('/calls')));
assert.doesNotThrow(() => assertRequestTabAccess(request('/agents'))); // Report filter lookup.
assert.throws(() => assertRequestTabAccess(request('/agents', '/agent-id')), { code: 'TAB_ACCESS_DENIED' });
assert.throws(() => assertRequestTabAccess(request('/agents', '/', 'POST')), { code: 'TAB_ACCESS_DENIED' });
assert.throws(() => assertRequestTabAccess(request('/campaigns', '/', 'POST')), { code: 'TAB_ACCESS_DENIED' });
assert.throws(() => assertRequestTabAccess(request('/dashboard')), { code: 'TAB_ACCESS_DENIED' });
assert.doesNotThrow(() => assertRequestTabAccess(request('/dashboard', '/analytics', 'GET', { ...auth, tabAccess: ['analytics'] })));
assert.throws(() => assertRequestTabAccess(request('/dashboard', '/', 'GET', { ...auth, tabAccess: ['analytics'] })), { code: 'TAB_ACCESS_DENIED' });
assert.throws(() => assertRequestTabAccess(request('/dashboard', '/analytics/', 'GET', { ...auth, tabAccess: ['dashboard'] })), { code: 'TAB_ACCESS_DENIED' });
assert.throws(() => assertRequestTabAccess(request('/queues', '/', 'GET', { ...auth, authType: 'api_key' })), { code: 'TAB_ACCESS_DENIED' });
assert.throws(() => assertRequestTabAccess(request('/api/public', '/', 'POST', { ...auth, authType: 'api_key' })), { code: 'TAB_ACCESS_DENIED' });
assert.throws(() => assertRequestTabAccess(request('/settings', '/', 'GET', { ...auth, role: 'COMPANY_USER', tabAccess: ['settings'] })), { code: 'TAB_ACCESS_DENIED' });
assert.doesNotThrow(() => assertRequestTabAccess(request('/auth', '/me', 'GET', { ...auth, tabAccess: [] })));
assert.equal(updateDeveloperSchema.safeParse({ tabAccess: ['invented'] }).success, false);
assert.equal(updateDeveloperSchema.safeParse({ tabAccess: [] }).success, true);
assert.equal(updateDeveloperSchema.safeParse({ tabAccess: null }).success, true);
assert.deepEqual(updateDeveloperSchema.parse({ tabAccess: ['reports', 'reports'] }).tabAccess, ['reports']);
const created = createDeveloperSchema.parse({ companyId: 'f4763eb8-84f3-4790-abd0-c56c2688a65c',
  fullName: 'Test User', email: 'test@example.com', password: 'test-password-123', tabAccess: ['reports'] });
assert.deepEqual(created.tabAccess, ['reports']);
console.log('Tab access validation and authorization checks passed');
