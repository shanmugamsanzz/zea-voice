import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';
const { getCall } = await import('../src/calls/call.service.js');
const auth = { role: 'COMPANY_USER', tenantId: 'tenant-a' };
for (const [saved, metadata, expected] of [
  ['Ravi', { leadName: 'Old lead', patient_name: 'Lakshmi' }, 'Ravi'],
  ['  Ravi  ', {}, 'Ravi'],
  [null, { leadName: 'Lead name' }, 'Lead name'],
  ['', { context: { customer_name: 'Customer name' } }, 'Customer name'],
  [null, { patient_name: 'Lakshmi' }, null],
]) {
  const call = await getCall(auth, 'call-a', { contextRunner: async operation => operation({
    async query(sql, values) {
      if (sql.includes('FROM call_sessions c')) {
        assert.deepEqual(values, ['call-a', 'tenant-a']);
        assert.match(sql, /contact.tenant_id=c.tenant_id/);
        assert.match(sql, /WHEN c.direction='inbound' THEN c.from_number/);
        assert.match(sql, /WHEN c.direction='outbound' THEN c.to_number/);
        assert.match(sql, /<> 'browser_test'/);
        return { rowCount: 1, rows: [{ id: 'call-a', tenant_id: 'tenant-a',
          saved_contact_name: saved, provider_metadata: metadata, duration_seconds: 0, cost: 0 }] };
      }
      return { rowCount: 0, rows: [] };
    }
  }) });
  assert.equal(call.contactName, expected);
}
console.log('PASS report saved caller name, lead fallback, patient-name exclusion and scoped lookup');
