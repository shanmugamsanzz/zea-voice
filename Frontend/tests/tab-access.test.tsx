import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { canAccessTab, companyTabs } from '../src/lib/tabAccess';
import { TabAccessToggles } from '../src/components/users/TabAccessToggles';

test('tab permissions preserve defaults, deny nested navigation, and respect role boundaries', () => {
  assert.equal(canAccessTab('DEVELOPER', null, 'agents/edit'), true);
  assert.equal(canAccessTab('DEVELOPER', ['reports'], 'agents/edit'), false);
  assert.equal(canAccessTab('DEVELOPER', [], 'dashboard'), false);
  assert.equal(canAccessTab('USER', ['settings'], 'settings'), false);
  assert.equal(canAccessTab('USER', ['reports'], 'reports'), true);
  assert.equal(canAccessTab('SUPER_ADMIN', [], 'companies'), true);
});
test('admin form lists every tab and marks restricted developer sections unavailable for users', () => {
  const html = renderToStaticMarkup(<TabAccessToggles value={['reports']} role="COMPANY_USER" onChange={() => {}} />);
  for (const [, label] of companyTabs) assert.ok(html.includes(`${label} access`));
  assert.equal((html.match(/role="switch"/g) ?? []).length, companyTabs.length);
  assert.equal((html.match(/checked=""/g) ?? []).length, 1);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
});
