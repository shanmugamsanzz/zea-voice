import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  COMPANY_AMBIENCE_LIMIT,
  createAmbienceAssetSchema,
  parseAmbienceInput,
  updateAmbienceAssetSchema,
} from '../src/ambience/ambience.schemas.js';
import { createAmbienceAsset, getAmbienceAsset, listAmbienceAssets } from '../src/ambience/ambience.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const auth = { tenantId, workspaceId, userId: '44444444-4444-4444-8444-444444444444', role: 'COMPANY_DEVELOPER' };

const validCreate = parseAmbienceInput(createAmbienceAssetSchema, { name: 'Hospital reception' });
assert.equal(validCreate.success, true);
assert.equal(validCreate.data.listeningVolumePercent, 10);
assert.equal(validCreate.data.speakingVolumePercent, 5);
assert.equal(validCreate.data.continueDuringSilence, true);
assert.equal(parseAmbienceInput(createAmbienceAssetSchema, { name: 'Rain', objectKey: 'other-company/private.mp3' }).success, false);
assert.equal(parseAmbienceInput(updateAmbienceAssetSchema, {}).success, false);

const listed = await listAmbienceAssets(auth, { page: 1, pageSize: 20 }, async (context, operation) => {
  assert.equal(context.tenantId, tenantId);
  assert.equal(context.workspaceId, workspaceId);
  return operation({
    async query(sql, values) {
      assert.match(sql, /tenant_id=\$1/);
      assert.match(sql, /workspace_id=\$2/);
      assert.deepEqual(values.slice(0, 2), [tenantId, workspaceId]);
      return {
        rows: [{
          id: assetId, tenant_id: tenantId, workspace_id: workspaceId, name: 'Hospital reception',
          description: null, status: 'active', storage_status: 'pending', original_file_name: null,
          object_key: 'private/source.wav', normalized_object_key: null, mime_type: null,
          size_bytes: null, duration_ms: null, audio_metadata: {}, listening_volume_percent: 10,
          speaking_volume_percent: 5, continue_during_silence: true, created_by: auth.userId,
          updated_by: auth.userId, created_at: new Date(), updated_at: new Date(), total_count: 1,
        }],
      };
    },
  });
});
assert.equal(listed.items.length, 1);
assert.equal(listed.items[0].hasSourceAudio, true);
assert.equal(Object.hasOwn(listed.items[0], 'objectKey'), false, 'Private B2 keys must not leave the service');
assert.deepEqual(listed.limits, { maximum: COMPANY_AMBIENCE_LIMIT, used: 1, remaining: 19 });

await assert.rejects(
  () => getAmbienceAsset(auth, assetId, async (_context, operation) => operation({
    async query(sql, values) {
      assert.match(sql, /tenant_id=\$1 AND workspace_id=\$2/);
      assert.deepEqual(values, [tenantId, workspaceId, assetId]);
      return { rowCount: 0, rows: [] };
    },
  })),
  (error) => error?.code === 'AMBIENCE_ASSET_NOT_FOUND' && error?.statusCode === 404,
);

await assert.rejects(
  () => createAmbienceAsset(auth, validCreate.data, async (_context, operation) => {
    let call = 0;
    return operation({
      async query(sql) {
        call += 1;
        if (call === 1) assert.match(sql, /pg_advisory_xact_lock/);
        if (call === 2) return { rows: [{ count: COMPANY_AMBIENCE_LIMIT }] };
        return { rows: [] };
      },
    });
  }),
  (error) => error?.code === 'AMBIENCE_ASSET_LIMIT_REACHED' && error?.statusCode === 409,
);

const migration = await readFile(new URL('../migrations/1785600000000_company-ambience-assets.js', import.meta.url), 'utf8');
assert.match(migration, /FOREIGN KEY \(tenant_id, workspace_id\)/);
assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /FORCE ROW LEVEL SECURITY/);
assert.match(migration, /company_ambience_assets_isolation_policy/);
assert.match(migration, /tenant_id = zea_current_tenant_id\(\)/);

console.log(JSON.stringify({ success: true, tasks: ['Company ambience tables', 'Tenant-isolated ambience APIs'] }));
