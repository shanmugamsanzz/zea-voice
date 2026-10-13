import assert from 'node:assert/strict';
import { permanentlyDeleteCampaign, campaignDeletionPreview } from '../src/campaigns/campaign-deletion.js';

const auth = { tenantId: 'tenant-a', userId: 'admin-a' };
const confirmation = { confirmation: 'DELETE', expectedTaskCount: 100 };
function fixture({ status = 'paused', active = false, exists = true, total = 100 } = {}) {
  const calls = [];
  return { calls, async query(sql, values) {
    calls.push({ sql, values });
    assert.equal(values[0], auth.tenantId, 'Every query must be tenant scoped');
    if (sql.includes('SELECT count(*)::int')) return { rowCount: 1, rows: [{total, remaining:98}] };
    if (sql.includes('SELECT id,name,status')) return {
      rowCount: exists ? 1 : 0, rows: exists ? [{ id: 'campaign-a', name: 'Test', status, workspace_id: 'workspace-a' }] : [],
    };
    if (sql.includes('SELECT 1 FROM call_sessions')) return { rowCount: active ? 1 : 0, rows: [] };
    return { rowCount: 1, rows: [] };
  } };
}
for (const options of [{status:'running'}, {active:true}, {exists:false}]) {
  const client = fixture(options);
  await assert.rejects(permanentlyDeleteCampaign(client, auth, 'campaign-a', confirmation), {
    code: options.status ? 'CAMPAIGN_MUST_BE_PAUSED' : options.active ? 'CAMPAIGN_HAS_ACTIVE_CALLS' : 'CAMPAIGN_NOT_FOUND',
  });
  assert.ok(client.calls.every(call => !/^(DELETE|UPDATE|INSERT)/.test(call.sql)));
}
for (const status of ['paused', 'draft', 'completed', 'failed', 'scheduled']) {
  const client = fixture({status});
  assert.deepEqual(await permanentlyDeleteCampaign(client, auth, 'campaign-a', confirmation), {id:'campaign-a',deleted:true});
  const deletion = client.calls.at(-1);
  assert.equal(deletion.sql, 'DELETE FROM campaigns WHERE tenant_id=$1 AND id=$2');
  assert.deepEqual(deletion.values, ['tenant-a','campaign-a']);
  assert.ok(client.calls.some(call => call.sql.includes('campaign_task_id=NULL,campaign_origin_attempt_id=NULL')));
  assert.ok(client.calls.some(call => call.sql.includes('CAMPAIGN_DELETED')));
  assert.ok(client.calls.every(call => !/(DELETE FROM|UPDATE) (call_sessions|call_transcript_entries|call_credit)/.test(call.sql)));
}
for (const input of [undefined, {confirmation:'delete',expectedTaskCount:100}, {confirmation:'DELETE',expectedTaskCount:-1}]) {
  const client = fixture();
  await assert.rejects(permanentlyDeleteCampaign(client, auth, 'campaign-a', input), {code:'CAMPAIGN_DELETE_CONFIRMATION_REQUIRED'});
  assert.equal(client.calls.length, 0);
}
const changed = fixture({total:101});
await assert.rejects(permanentlyDeleteCampaign(changed,auth,'campaign-a',confirmation), {code:'CAMPAIGN_DELETE_COUNT_CHANGED'});
assert.ok(changed.calls.every(call => !/^(DELETE|UPDATE|INSERT)/.test(call.sql)));
const preview = await campaignDeletionPreview(fixture(),auth,'campaign-a');
assert.equal(preview.totalTasks,100);
assert.equal(preview.remainingTasks,98);
console.log('Campaign permanent-deletion guards and history-preservation checks passed (mock database)');
