import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { expireBrowserTestSessions } = await import('../src/voice/browser-test-session.service.js');

let queryText = null;
const result = await expireBrowserTestSessions({
  contextRunner: async (operation) => operation({
    query: async (sql, parameters) => {
      queryText = sql;
      assert.deepEqual(parameters, ['browser_test']);
      return { rowCount: 2, rows: [{ id: 'expired-ringing' }, { id: 'expired-connected' }] };
    },
  }),
});

assert.equal(result.expired, 2);
assert.match(queryText, /status IN \('ringing','connected'\)/u);
assert.match(queryText, /provider_metadata->>'source'=\$1/u);
assert.match(queryText, /expiresAt/u);
assert.match(queryText, /credit_billing_finalized=true/u);
console.log('Browser test expiration verification passed.');
