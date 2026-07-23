import assert from 'node:assert/strict';
import { withPlatformAdminContext } from '../src/infrastructure/database-context.js';
import { closeDatabase } from '../src/infrastructure/database.js';

const inboundId = process.env.VOICE_TEST_INBOUND_CALL_ID;
const outboundId = process.env.VOICE_TEST_OUTBOUND_CALL_ID;
if (!inboundId || !outboundId) {
  throw new Error('Set VOICE_TEST_INBOUND_CALL_ID and VOICE_TEST_OUTBOUND_CALL_ID to completed real call-session UUIDs');
}

async function verify(callId, direction) {
  return withPlatformAdminContext(null, async (client) => {
    const result = await client.query(`SELECT c.id,c.tenant_id,c.direction,c.status,c.duration_seconds,
      c.provider_metadata,
      (SELECT count(*)::int FROM call_transcript_entries t WHERE t.call_session_id=c.id) transcript_entries,
      (SELECT count(*)::int FROM call_provider_usage u WHERE u.call_session_id=c.id) provider_usage_rows
      FROM call_sessions c WHERE c.id=$1`, [callId]);
    assert.equal(result.rowCount, 1, `${direction} call was not found`);
    const call = result.rows[0];
    assert.equal(call.direction, direction);
    assert.equal(call.status, 'completed');
    assert.ok(Number(call.duration_seconds) > 0);
    assert.ok(call.transcript_entries >= 2, `${direction} call has no caller/agent transcript pair`);
    assert.ok(call.provider_usage_rows >= 3, `${direction} call is missing STT/LLM/TTS usage`);
    assert.equal(call.provider_metadata?.voiceRuntime?.finalized, true);
    assert.ok(Array.isArray(call.provider_metadata?.voiceRuntime?.metrics?.latency?.firstResponseAudioMs));
    return {
      id: call.id,
      direction,
      durationSeconds: Number(call.duration_seconds),
      transcriptEntries: call.transcript_entries,
      providerUsageRows: call.provider_usage_rows,
      latency: call.provider_metadata.voiceRuntime.metrics.latency,
    };
  });
}

try {
  const inbound = await verify(inboundId, 'inbound');
  const outbound = await verify(outboundId, 'outbound');
  console.log(JSON.stringify({ success: true, task: 'Real Plivo inbound/outbound calls', inbound, outbound }, null, 2));
} finally {
  await closeDatabase();
}
