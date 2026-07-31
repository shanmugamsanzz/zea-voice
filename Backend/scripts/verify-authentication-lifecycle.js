import assert from 'node:assert/strict';
import { sessionExpirations } from '../src/auth/session-policy.js';
import { updatePlatformSettingsSchema } from '../src/settings/platform-setting.schemas.js';
import { up as sessionMigration } from '../migrations/1785800000000_platform-session-thirty-days.js';

const FIFTEEN_MINUTES_MS = 15 * 60_000;
const THIRTY_DAYS_MS = 30 * 86_400_000;
const THIRTY_DAYS_SECONDS = 2_592_000;
const startedAt = new Date('2026-07-27T00:00:00.000Z');
const expirations = sessionExpirations(startedAt, {
  accessTokenTtlMinutes: 15,
  refreshTokenTtlDays: 30,
});

assert.equal(expirations.accessExpiresAt.getTime() - startedAt.getTime(), FIFTEEN_MINUTES_MS);
assert.equal(expirations.refreshExpiresAt.getTime() - startedAt.getTime(), THIRTY_DAYS_MS);
assert.equal(updatePlatformSettingsSchema.safeParse({ maxSessionTimeoutSeconds: THIRTY_DAYS_SECONDS }).success, true);
assert.equal(updatePlatformSettingsSchema.safeParse({ maxSessionTimeoutSeconds: THIRTY_DAYS_SECONDS + 1 }).success, false);

const statements = [];
await sessionMigration({ sql: (statement) => statements.push(statement) });
const migrationSql = statements.join('\n');
assert.match(migrationSql, /SET DEFAULT 2592000/);
assert.match(migrationSql, /SET max_session_timeout_seconds = 2592000/);
assert.match(migrationSql, /BETWEEN 300 AND 2592000/);

assert.throws(() => sessionExpirations(new Date('invalid'), {
  accessTokenTtlMinutes: 15, refreshTokenTtlDays: 30,
}), /valid session start date/);

console.log(JSON.stringify({
  success: true,
  accessTokenLifetime: '15 minutes verified',
  refreshTokenLifetime: '30 days verified',
  platformMaximumSession: '30 days verified',
  migrationBackfill: 'verified without database mutation',
}, null, 2));
