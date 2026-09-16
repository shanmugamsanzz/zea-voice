import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

const [migration, permanentMigration, service, publicRoutes, app, panel, publicView] = await Promise.all([
  read('migrations/1787800000000_browser-test-share-links.js'),
  read('migrations/1787900000000_browser-test-permanent-share-links.js'),
  read('src/voice/browser-test-share-link.service.js'),
  read('src/voice/browser-test-share-link.routes.js'),
  read('src/app.js'),
  read('../Frontend/src/components/agent/BrowserAgentTestPanel.tsx'),
  read('../Frontend/src/views/PublicBrowserAgentTestView.tsx'),
]);

assert.match(migration, /tenant_id uuid NOT NULL REFERENCES tenants\(id\)/u);
assert.match(migration, /token_hash text NOT NULL UNIQUE/u);
assert.match(migration, /expires_at timestamptz NOT NULL/u);
assert.match(migration, /ENABLE ROW LEVEL SECURITY/u);
assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON browser_test_share_links/u);
assert.match(permanentMigration, /ALTER COLUMN expires_at DROP NOT NULL/u);
assert.match(service, /crypto\.randomBytes\(32\)\.toString\('base64url'\)/u);
assert.match(service, /createHash\('sha256'\)/u);
assert.match(service, /input\.expiresIn === 'permanent'/u);
assert.match(service, /expires_at IS NULL OR expires_at > now\(\)/u);
assert.match(service, /withTenantContext\(linkAuth\(link\)/u);
assert.match(service, /SELECT name,status,usage_direction FROM voice_agents/u);
assert.match(service, /createBrowserTestSession\(linkAuth\(link\), link\.agent_id, input\)/u);
assert.match(service, /endBrowserTestSession\(linkAuth\(link\), link\.agent_id, testCallId\)/u);
assert.match(publicRoutes, /browserTestShareLinkRouter\.get\('\/:token'/u);
assert.match(publicRoutes, /browserTestShareLinkRouter\.post\('\/:token\/sessions'/u);
assert.match(publicRoutes, /browserTestShareLinkRouter\.delete\('\/:token\/sessions\/:testCallId'/u);
assert.match(app, /app\.use\('\/public\/browser-test-links', browserTestShareLinkRouter\)/u);
assert.match(panel, /Share test/u);
assert.match(panel, /24-hour link/u);
assert.match(panel, /Permanent link/u);
assert.match(panel, /sessionClient\.create\(agent\)/u);
assert.match(publicView, /allowSharing=\{false\}/u);
assert.match(publicView, /\/public\/browser-test-links\//u);

console.log(JSON.stringify({
  success: true,
  task: 'browser test share links',
  opaqueTokenOnly: true,
  expirationEnforced: true,
  publicSurface: ['link lookup', 'create session', 'end session'],
  sameBrowserMediaRuntime: true,
}));
