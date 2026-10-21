import assert from 'node:assert/strict';
import test from 'node:test';
import { accountIdentity } from '../src/lib/accountIdentity';
test('accounts supply their own name, company and initials', () => {
  assert.deepEqual(accountIdentity({ firstName: 'Anu', lastName: 'Kumar', tenantName: 'Balaji' }), { name: 'Anu Kumar', company: 'Balaji', initials: 'AK' });
  assert.deepEqual(accountIdentity({ firstName: 'Shanmugam', lastName: '-', tenantName: 'Shanmuga' }), { name: 'Shanmugam', company: 'Shanmuga', initials: 'S' });
});
test('cleared and missing identities use neutral fallbacks', () => {
  assert.deepEqual(accountIdentity({ email: 'user@example.com' }), { name: 'user@example.com', company: '', initials: 'U' });
  assert.deepEqual(accountIdentity(null), { name: 'Account', company: '', initials: 'A' });
});
