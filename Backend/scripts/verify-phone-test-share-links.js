import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
process.env.NODE_ENV = 'test'; process.env.LOG_LEVEL = 'silent';
process.env.VOICE_COMPANY_QUEUE_ENABLED = 'true'; process.env.VOICE_COMPANY_QUEUE_TENANT_IDS = '';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost/test'; process.env.REDIS_HOST ??= 'localhost';
const share = await import('../src/agents/phone-test-share-link.service.js');
const limits = await import('../src/agents/phone-test-share-rate-limit.js');
const { AppError } = await import('../src/middleware/errors.js');
const auth = { userId: randomUUID(), tenantId: randomUUID(), workspaceId: randomUUID(), role: 'COMPANY_DEVELOPER' };
const agentId = randomUUID();
let now = Date.now(), creatorActive = true, canceled = false;
const links = new Map();
const query = async (sql, v) => {
  if (sql.includes('SELECT a.*,pn.e164')) return {rowCount:1,rows:[{status:'active',usage_direction:'both',e164:'+918065587447',account_status:'connected',answer_url:'https://example.com/answer',hangup_url:'https://example.com/hangup',max_total_concurrency:2}]};
  if (sql.includes('SELECT * FROM agent_phone_test_requests')) return {rowCount:0,rows:[]};
  if (sql.includes('SELECT a.name FROM voice_agents')) return { rowCount: v[0] === agentId && v[1] === auth.tenantId && v[2] === auth.workspaceId ? 1 : 0, rows: [{ name: 'Family Assistant' }] };
  if (sql.startsWith('INSERT INTO phone_test_share_links')) {
    const [id,tenant_id,workspace_id,agent_id,created_by,token_hash,expires_at] = v;
    const row = { id,tenant_id,workspace_id,agent_id,created_by,token_hash,expires_at,revoked_at: null,created_at: new Date(now) };
    links.set(id,row); return { rowCount: 1, rows: [row] };
  }
  if (sql.includes('FROM phone_test_share_links WHERE token_hash')) {
    const row = [...links.values()].find(l => l.token_hash === v[0]); return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
  }
  if (sql.includes('SELECT l.* FROM phone_test_share_links')) {
    assert.match(sql,/l.revoked_at IS NULL/); assert.match(sql,/l.expires_at>now\(\)/);
    assert.match(sql,/u.status='active'/); assert.match(sql,/m.role='company_developer'/);
    assert.match(sql,/FOR SHARE OF l/);
    const row = links.get(v[0]);
    const valid = row && row.tenant_id === v[1] && row.workspace_id === v[2] && row.agent_id === v[3]
      && !row.revoked_at && (!row.expires_at || row.expires_at.getTime() > now) && creatorActive;
    return { rowCount: valid ? 1 : 0, rows: valid ? [row] : [] };
  }
  if (sql.startsWith('SELECT id,agent_id,expires_at')) {
    return { rows: [...links.values()].filter(l => l.tenant_id === v[0] && l.workspace_id === v[1] && l.agent_id === v[2]) };
  }
  if (sql.includes('FROM tenant_limits') || sql.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
  if (sql.startsWith('UPDATE phone_test_share_links')) {
    const row = links.get(v[0]);
    if (!row || row.tenant_id !== v[1] || row.workspace_id !== v[2] || row.agent_id !== v[3]) return { rowCount: 0, rows: [] };
    row.revoked_at ??= new Date(now); return { rowCount: 1, rows: [row] };
  }
  if (sql.startsWith('UPDATE agent_phone_test_requests')) {
    assert.match(sql,/status='queued'/); assert.equal(v[1],auth.tenantId); canceled = true; return { rowCount: 1, rows: [] };
  }
  if (sql.includes('SELECT id,status,queue_reason FROM agent_phone_test_requests')) {
    assert.match(sql,/request_key=\$2 AND share_link_id=\$3 AND tenant_id=\$4/);
    return { rowCount: 0, rows: [] };
  }
  throw new Error(`Unexpected query: ${sql}`);
};
const deps = { tenantContextRunner: fn => fn({ query }), contextRunner: (_user, fn) => fn({ query }), now: () => now };
for (const invalid of [{...auth,role:'COMPANY_USER'},{...auth,authType:'api_key'}]) {
  await assert.rejects(share.createPhoneTestShareLink(invalid,agentId,{expiresIn:'24h'},deps), e => e.code === 'FORBIDDEN');
  await assert.rejects(share.revokePhoneTestShareLink(invalid,agentId,randomUUID(),deps), e => e.code === 'FORBIDDEN');
}
const temporary = await share.createPhoneTestShareLink(auth,agentId,{expiresIn:'24h'},deps);
assert.equal(temporary.expiresAt.getTime() - now,86400000); assert.equal(temporary.token.length,43);
assert.equal(links.get(temporary.id).token_hash,share.phoneShareTokenHash(temporary.token));
assert.ok(!JSON.stringify(links.get(temporary.id)).includes(temporary.token));
const permanent = await share.createPhoneTestShareLink(auth,agentId,{expiresIn:'permanent'},deps);
assert.equal(permanent.expiresAt,null); assert.equal(permanent.permanent,true);
assert.notEqual(permanent.token,temporary.token);
const listed = await share.listPhoneTestShareLinks(auth,agentId,deps);
assert.equal(listed.length,2); assert.ok(listed.every(link => !('token' in link) && !('token_hash' in link)));
assert.deepEqual(Object.keys(await share.getPublicPhoneTestLink(permanent.token,deps)).sort(),['agentName','expiresAt','permanent']);
await assert.rejects(share.getPublicPhoneTestLink('invalid',deps), e => e.code === 'PHONE_SHARE_LINK_UNAVAILABLE');
now += 86400000;
await assert.rejects(share.getPublicPhoneTestLink(temporary.token,deps), e => e.code === 'PHONE_SHARE_LINK_UNAVAILABLE');
creatorActive = false;
await assert.rejects(share.getPublicPhoneTestLink(permanent.token,deps), e => e.code === 'PHONE_SHARE_LINK_UNAVAILABLE'); creatorActive = true;
await assert.rejects(share.revokePhoneTestShareLink({...auth,tenantId:randomUUID()},agentId,permanent.id,deps), e => e.code === 'PHONE_SHARE_LINK_UNAVAILABLE');
await assert.rejects(share.requestPublicPhoneTest(permanent.token,{phone:'+919123456789',requestId:randomUUID(),consent:false},'ip',deps), e => e.code === 'VALIDATION_ERROR');
await assert.rejects(share.requestPublicPhoneTest(permanent.token,{phone:'+14155551234',requestId:randomUUID(),consent:true},'ip',deps), e => e.code === 'PHONE_SHARE_DESTINATION_UNAVAILABLE');
await assert.rejects(share.requestPublicPhoneTest(permanent.token,{phone:'+919123456789',requestId:randomUUID(),consent:true},'ip',{
  ...deps, consumeLimits:async()=>{}, validateModels:async()=>{},
  checkCredits:async()=>{throw new AppError(409,'Company wallet balance is private','COMPANY_CREDITS_EXHAUSTED',{balance:123,walletId:'private'});},
}), e => e.code === 'PHONE_SHARE_CALL_UNAVAILABLE' && e.details === undefined && !e.message.includes('wallet'));
await assert.rejects(share.getPublicPhoneTestStatus(permanent.token,randomUUID(),randomUUID(),deps), e => e.code === 'PHONE_SHARE_LINK_UNAVAILABLE');
await share.revokePhoneTestShareLink(auth,agentId,permanent.id,deps); assert.equal(canceled,true);
await assert.rejects(share.getPublicPhoneTestLink(permanent.token,deps), e => e.code === 'PHONE_SHARE_LINK_UNAVAILABLE');
// Exercise distributed quota keys and fail-closed response behavior.
const counts = new Map();
const redis = { status:'ready',eval:async (_script,count,...args) => {
  const keys = args.splice(0,count);
  assert.ok(keys.every(key => key.includes('{public-calls}') && !key.includes('+919123456789') && !key.includes('203.0.113')));
  for (let i=0;i<count;i++) if ((counts.get(keys[i]) ?? 0) >= args[i*2]) return [i+1,args[i*2+1]];
  for (const key of keys) counts.set(key,(counts.get(key) ?? 0)+1);
  return [0,0];
} };
for (let i=0;i<3;i++) await limits.consumePhoneShareCallLimits({linkId:randomUUID(),tenantId:randomUUID(),phone:'+919123456789',ip:`203.0.113.${i}`},redis);
await assert.rejects(limits.consumePhoneShareCallLimits({linkId:randomUUID(),tenantId:randomUUID(),phone:'+919123456789',ip:'203.0.113.9'},redis), e => e.statusCode === 429 && e.details.retryAfterSeconds === 3600);
await assert.rejects(limits.consumePhoneShareReadLimit('ip',{status:'reconnecting'}), e => e.statusCode === 503);
await assert.rejects(limits.consumePhoneShareReadLimit('ip',{status:'ready',eval:async()=>{throw new Error('Redis unavailable');}}), e => e.statusCode === 503);
console.log('Phone share links verified: role/tenant scope, 24h/permanent, hashed tokens, expiry/revocation, creator permissions, private status receipts, consent/destination limits and fail-closed quotas.');
