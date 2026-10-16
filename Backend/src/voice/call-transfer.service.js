import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../middleware/errors.js';
import { decryptCredential } from '../security/credential-crypto.js';
import { validatePlivoAccountSignatures } from '../telephony/plivo-webhook.service.js';
import { transferPlivoCall, stopPlivoCallStreams, hangupPlivoCall, getPlivoCallDetails } from '../telephony/plivo.client.js';
import { buildPlivoStreamXml } from './plivo-answer.service.js';
import { voiceCallOwnership } from './call-ownership.service.js';
import { transferRuntimes } from './transfer-runtime-registry.js';
import { createTransferRepository } from './call-transfer.repository.js';
import { isCallTransferEnabledForAgent } from './call-transfer-feature.js';
import { verifiedTransferResult } from './transfer-follow-up.js';

const activeStates = ['requested', 'ringing', 'bridged', 'resuming'];
const failures = new Set(['busy', 'failed', 'cancel', 'timeout', 'no-answer']);
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export const endTransferXml = '<Response><Hangup/></Response>';
// Direct mode never promises a callback. This is a transport fallback, not an agent answer.
export const failedTransferXml = '<Response><Speak>The transfer could not be completed. Please try again later. Goodbye.</Speak><Hangup/></Response>';

export function createCallTransferService(dependencies = {}) {
  const repo = dependencies.repository ?? createTransferRepository();
  const runtimes = dependencies.runtimes ?? transferRuntimes;
  const decrypt = dependencies.decrypt ?? decryptCredential;
  const ownership = dependencies.ownership ?? voiceCallOwnership;
  const heartbeatTimers = new Map();
  const resumeOperations = new Map();
  const log = dependencies.logger ?? logger;
  const enabled = call => dependencies.enabled ?? isCallTransferEnabledForAgent(call?.agentId);
  const base = () => {
    const url = new URL(dependencies.publicBaseUrl ?? env.PUBLIC_BASE_URL);
    if (url.protocol !== 'https:') throw new AppError(503, 'Transfers require a public HTTPS URL', 'TRANSFER_PUBLIC_URL_REQUIRED');
    return url.origin;
  };
  const callbackUrl = (id, action) => `${base()}/webhooks/plivo/transfer/${id}/${action}`;
  const api = (fn, row, ...args) => fn(row.auth_id, decrypt(row.auth_token_encrypted), ...args, dependencies.fetchImpl);
  const event = (row, state) => log.info({ stage: 'voice.transfer', callId: row.call_id,
    transferId: row.id, state }, 'Native call transfer state');
  function stopHeartbeat(callId) { clearInterval(heartbeatTimers.get(callId)); heartbeatTimers.delete(callId); }
  function holdOwnership(call, attempt) {
    if (heartbeatTimers.has(call.id)) return;
    let checking = false;
    let lastProviderCheck = Date.now();
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void (async () => {
        const row = await repo.get(attempt.id);
        if (!row || row.call_ended_at) {
          await runtimes.get(call.id)?.hangup(); stopHeartbeat(call.id); return;
        }
        const owned = await ownership.heartbeat({ tenantId: call.tenantId, providerCallId: call.providerCallId });
        if (!owned) { stopHeartbeat(call.id); return; }
        // Keep a missed final hangup webhook from retaining the runtime/capacity forever.
        if (Date.now() - lastProviderCheck >= 60_000) {
          lastProviderCheck = Date.now();
          const details = await api(dependencies.getCall ?? getPlivoCallDetails, row, row.provider_call_id);
          if (details?.end_time) {
            await runtimes.get(call.id)?.hangup();
            await ownership.release({ tenantId: call.tenantId, providerCallId: call.providerCallId });
          }
        }
      })().catch(() => log.warn({ stage: 'voice.transfer_heartbeat_failed', callId: call.id }, 'Transfer ownership check failed'))
        .finally(() => { checking = false; });
    }, env.VOICE_CALL_HEARTBEAT_INTERVAL_MS);
    timer.unref?.(); heartbeatTimers.set(call.id, timer);
  }
  async function cancelStaff(row) {
    if (!row.staff_call_id || row.staff_call_id === row.provider_call_id) return;
    try { await api(dependencies.hangup ?? hangupPlivoCall, row, row.staff_call_id); }
    catch { log.warn({ stage: 'voice.transfer_staff_cancel_failed', callId: row.call_id, transferId: row.id }, 'Staff leg cancellation deferred to Plivo A-leg teardown'); }
  }
  async function verify(input) {
    const row = await repo.get(input.id);
    if (!row) throw new AppError(404, 'Transfer was not found', 'TRANSFER_NOT_FOUND');
    if (!(dependencies.validateSignatures ?? validatePlivoAccountSignatures)({
      url: callbackUrl(row.id, input.action), nonce: input.nonce,
      signature: input.signature, mainSignature: input.mainSignature,
      authToken: decrypt(row.auth_token_encrypted), mainAuthToken: decrypt(row.main_auth_token_encrypted), params: input.payload,
    })) throw new AppError(401, 'Invalid Plivo transfer signature', 'PLIVO_SIGNATURE_INVALID');
    const aleg = input.action === 'dial' || input.action === 'recover'
      ? input.payload.CallUUID : input.payload.DialALegUUID;
    if (aleg !== row.provider_call_id) throw new AppError(403, 'Transfer callback call mismatch', 'TRANSFER_CALL_MISMATCH');
    const staffId = input.payload.DialBLegUUID;
    if (staffId && (staffId === aleg || (row.staff_call_id && staffId !== row.staff_call_id))) {
      throw new AppError(403, 'Transfer callback staff leg mismatch', 'TRANSFER_STAFF_MISMATCH');
    }
    const to = input.payload.DialBLegTo;
    if (to && to.replace(/\D/g, '') !== row.destination_number.replace(/\D/g, '')) {
      throw new AppError(403, 'Transfer callback destination mismatch', 'TRANSFER_DESTINATION_MISMATCH');
    }
    return row;
  }
  async function resumeXml(row, result) {
    if (row.call_ended_at || row.state === 'canceled') return endTransferXml;
    if (row.resume_xml) return row.resume_xml;
    if (resumeOperations.has(row.id)) return resumeOperations.get(row.id);
    const operation = performResume(row, result);
    resumeOperations.set(row.id, operation);
    try { return await operation; } finally { resumeOperations.delete(row.id); }
  }
  async function performResume(row, result) {
    const runtime = runtimes.get(row.call_id);
    if (row.call_ended_at || row.state === 'canceled') return endTransferXml;
    if (!runtime || row.mode !== 'wait_and_return') {
      await repo.transition(row.id, ['requested', 'ringing', 'resuming'], 'failed', { result });
      return failedTransferXml;
    }
    const moved = row.state === 'resuming' ? row
      : await repo.transition(row.id, ['requested', 'ringing'], 'resuming', { result });
    if (!moved) return endTransferXml;
    runtime.resumeResult ??= verifiedTransferResult(row, result);
    if (runtime.resumeResult.transferId !== row.id) runtime.resumeResult = verifiedTransferResult(row, result);
    // The previous socket must be gone before Plivo opens the replacement stream.
    await runtime.detach();
    event(row, 'resuming');
    const response = (dependencies.buildStreamXml ?? buildPlivoStreamXml)(runtime.call);
    return await repo.saveResumeXml(row.id, response) ?? endTransferXml;
  }
  const service = {
    async available(call) {
      return Boolean(enabled(call) && call.providerCallId && !call.providerCallId.startsWith('browser-test-') && await repo.enabled(call));
    },
    register(runtime) {
      if (runtimes.has(runtime.call.id)) throw new AppError(409, 'Call transfer runtime already registered', 'TRANSFER_RUNTIME_CONFLICT');
      runtimes.set(runtime.call.id, runtime);
    },
    unregister(callId) { stopHeartbeat(callId); runtimes.delete(callId); },
    async request(call) {
      if (!enabled(call)) throw new AppError(409, 'Native transfer is disabled for this agent', 'TRANSFER_DISABLED');
      const runtime = runtimes.get(call.id);
      if (!runtime || runtime.call.tenantId !== call.tenantId || runtime.call.providerCallId !== call.providerCallId) {
        throw new AppError(409, 'Live call transfer runtime is unavailable', 'TRANSFER_RUNTIME_UNAVAILABLE');
      }
      base();
      const { attempt: row, duplicate } = await repo.reserve(call);
      if (duplicate) return { success: true, transferRequested: true, connected: row.state === 'bridged', duplicate: true };
      event(row, 'requested');
      let requestStarted = false;
      try {
        await runtime.pause();
        const current = await repo.get(row.id);
        if (current?.call_ended_at || current?.state === 'canceled') return { success: false, reason: 'caller_hung_up' };
        holdOwnership(call, row);
        requestStarted = true;
        const response = await api(dependencies.transfer ?? transferPlivoCall, row, row.provider_call_id, callbackUrl(row.id, 'dial'));
        if (!['transfer executed', 'call transferred'].includes(response?.message)) {
          throw new AppError(502, 'Transfer was not accepted', 'TRANSFER_NOT_ACCEPTED');
        }
        // Transfer must be queued before stopping keepCallAlive streaming.
        try { if (runtime.streamActive?.() !== false) await api(dependencies.stopStreams ?? stopPlivoCallStreams, row, row.provider_call_id); }
        catch { log.warn({ stage: 'voice.transfer_stream_stop_failed', callId: call.id }, 'Transfer queued; stream cleanup will be retried by the dial callback'); }
        return { success: true, transferRequested: true, connected: false, transferId: row.id };
      } catch (error) {
        // An HTTP timeout is ambiguous: never restore AI or retry Dial blindly.
        // Route the existing A-leg to a signed recovery endpoint instead.
        const latest = await repo.get(row.id);
        if (latest && ['ringing', 'bridged', 'resuming', 'returned', 'canceled', 'ended'].includes(latest.state)) {
          return { success: true, transferRequested: true, connected: latest.state === 'bridged', transferId: row.id };
        }
        // Claim recovery before redirecting so a delayed initial Dial fetch cannot
        // start another staff leg after a timed-out HTTP request.
        if (!requestStarted || error.details?.providerStatus >= 400 && error.details.providerStatus < 500) {
          await repo.transition(row.id, ['requested'], 'failed', { result: 'request_rejected' });
          stopHeartbeat(call.id);
          await runtime.restore(verifiedTransferResult(row, 'request_rejected'));
          return { success: false, transferRequested: false, connected: false, reason: 'request_rejected' };
        }
        const recovery = await repo.transition(row.id, ['requested'], 'resuming', { result: 'request_failed' });
        if (!recovery) return { success: false, reason: 'transfer_state_changed' };
        try {
          const response = await api(dependencies.transfer ?? transferPlivoCall, row, row.provider_call_id, callbackUrl(row.id, 'recover'));
          if (!['transfer executed', 'call transferred'].includes(response?.message)) throw new Error('Recovery not accepted');
          if (runtime.streamActive?.() !== false) await api(dependencies.stopStreams ?? stopPlivoCallStreams, row, row.provider_call_id);
        } catch {
          await repo.transition(row.id, ['resuming'], 'failed', { result: 'request_failed' });
          stopHeartbeat(call.id);
          await runtime.restore(verifiedTransferResult(row, 'request_failed'));
        }
        return { success: false, transferRequested: false, connected: false, reason: 'request_failed' };
      }
    },
    async callback(input) {
      const row = await verify(input);
      if (input.action === 'events') {
        if (input.payload.DialBLegUUID && (row.call_ended_at || ['canceled', 'returned', 'failed', 'resuming'].includes(row.state))) {
          await cancelStaff({ ...row, staff_call_id: input.payload.DialBLegUUID });
          return null;
        }
        if (['answer', 'connected'].includes(input.payload.DialAction)) {
          if (!input.payload.DialBLegUUID) throw new AppError(400, 'Staff leg is required', 'TRANSFER_STAFF_ID_REQUIRED');
          const changed = await repo.transition(row.id, ['requested', 'ringing'], 'bridged', { staffCallId: input.payload.DialBLegUUID });
          if (changed) { event(row, 'bridged'); await runtimes.get(row.call_id)?.bridged(); }
          else {
            const latest = await repo.get(row.id);
            if (latest?.state === 'canceled' || latest?.call_ended_at) {
              await cancelStaff({ ...row, staff_call_id: input.payload.DialBLegUUID });
            }
          }
        }
        return null;
      }
      if (row.call_ended_at || ['canceled', 'ended'].includes(row.state)) return endTransferXml;
      if (input.action === 'dial') {
        if (row.state === 'resuming') return resumeXml(row, row.result ?? 'request_failed');
        if (!['requested', 'ringing'].includes(row.state)) return endTransferXml;
        await repo.transition(row.id, ['requested'], 'ringing');
        const runtime = runtimes.get(row.call_id);
        if (!runtime) return failedTransferXml;
        // No LLM/AI audio continues into the staff bridge.
        await runtime.detach();
        event(row, 'ringing');
        return `<Response><Dial timeout="${row.ring_timeout_seconds}" callerId="${xml(row.caller_id)}" action="${xml(callbackUrl(row.id, 'result'))}" method="POST" redirect="true" callbackUrl="${xml(callbackUrl(row.id, 'events'))}" callbackMethod="POST"><Number>${xml(row.destination_number)}</Number></Dial></Response>`;
      }
      if (input.action === 'recover') return resumeXml(row, 'request_failed');
      if (input.action === 'result') {
        const status = input.payload.DialStatus;
        if (status === 'completed' || row.state === 'bridged') {
          await repo.transition(row.id, activeStates, 'ended', { result: 'completed', staffCallId: input.payload.DialBLegUUID || null });
          event(row, 'ended');
          return endTransferXml;
        }
        if (!failures.has(status)) throw new AppError(400, 'Unknown Dial result', 'TRANSFER_RESULT_INVALID');
        return resumeXml(row, status);
      }
      throw new AppError(400, 'Invalid transfer action', 'TRANSFER_ACTION_INVALID');
    },
    async resumed(callId) {
      const runtime = runtimes.get(callId);
      if (!runtime?.resumeResult) return;
      await repo.transition(runtime.resumeResult.transferId, ['resuming'], 'returned');
      stopHeartbeat(callId);
    },
    async callerHangup(providerCallId) {
      const rows = await repo.cancelCall(providerCallId);
      for (const row of rows) { stopHeartbeat(row.call_id); await cancelStaff(row); }
    },
  };
  return service;
}

export const callTransferService = createCallTransferService();
