// The insert trigger handles all creators (inbound, campaign, phone-test and
// shared-link calls). This bounded helper attaches existing historical calls.
export async function backfillConversationCallLinks(client, {tenantId,limit=200}={}) {
  if(tenantId!==undefined&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(tenantId))throw new TypeError('tenantId must be a UUID');
  if(!Number.isInteger(limit)||limit<1||limit>1000)throw new TypeError('limit must be between 1 and 1000');
  // Concurrent batches claim different calls. Processing through the trigger's
  // helper makes retries idempotent and preserves names set during live calls.
  const calls=await client.query(`SELECT c.id FROM call_sessions c
    WHERE ($1::uuid IS NULL OR c.tenant_id=$1)
      AND COALESCE(c.provider_metadata->>'source','')<>'browser_test'
      AND NOT EXISTS(SELECT 1 FROM conversation_call_links l WHERE l.call_session_id=c.id AND l.tenant_id=c.tenant_id)
    ORDER BY c.created_at,c.id LIMIT $2 FOR UPDATE OF c SKIP LOCKED`,[tenantId??null,limit]);
  let linked=0;
  for(const call of calls.rows) {
    const result=await client.query('SELECT zea_link_call_conversation($1) AS conversation_id',[call.id]);
    if(result.rows[0]?.conversation_id)linked++;
  }
  return {selected:calls.rows.length,linked};
}
