import { withAuthServiceContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { env } from '../config/env.js';

function map(row, created) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    providerCallId: row.provider_call_id,
    agentId: row.agent_id,
    from: row.from_number,
    to: row.to_number,
    direction: row.direction,
    status: row.status,
    providerMetadata: row.provider_metadata ?? {},
    created,
  };
}

function assertSameCall(row, input) {
  if (row.tenant_id !== input.runtimeProfile.agent.tenantId
    || row.agent_id !== input.runtimeProfile.agent.id
    || row.from_number !== input.call.from
    || row.to_number !== input.call.to
    || row.direction !== input.call.direction) {
    throw new AppError(409, 'Provider call identifier is already used by a different call', 'VOICE_CALL_ID_CONFLICT');
  }
}

export function createVoiceCallSession(input, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withAuthServiceContext;
  return contextRunner(async (client) => {
    const existing = await client.query(
      `SELECT * FROM call_sessions WHERE telephony_account_id=$1 AND provider_call_id=$2`,
      [input.call.telephonyAccountId, input.call.providerCallId],
    );
    if (existing.rowCount) {
      assertSameCall(existing.rows[0], input);
      const connected = await client.query(`UPDATE call_sessions
        SET status='connected',answered_at=COALESCE(answered_at,now())
        WHERE id=$1 AND ended_at IS NULL RETURNING *`, [existing.rows[0].id]);
      if (!connected.rowCount) throw new AppError(409, 'Existing call session has already ended', 'VOICE_CALL_ALREADY_ENDED');
      return map(connected.rows[0], false);
    }
    try {
      const result = await client.query(
        `INSERT INTO call_sessions
          (tenant_id,workspace_id,telephony_account_id,phone_number_id,provider_call_id,
           agent_id,agent_name,from_number,to_number,direction,status,ringing_at,answered_at,provider_metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'connected',now(),now(),$11::jsonb)
         RETURNING *`,
        [
          input.runtimeProfile.agent.tenantId,
          input.runtimeProfile.agent.workspaceId,
          input.call.telephonyAccountId,
          input.call.phoneNumberId,
          input.call.providerCallId,
          input.runtimeProfile.agent.id,
          input.runtimeProfile.agent.name,
          input.call.from,
          input.call.to,
          input.call.direction,
          JSON.stringify({
            source: 'plivo-answer',
            preCall: { status: 'pending' },
            sttProviderId: input.runtimeProfile.providers.stt.providerId,
            sttModelId: input.runtimeProfile.providers.stt.modelId,
            llmProviderId: input.runtimeProfile.providers.llm.providerId,
            llmModelId: input.runtimeProfile.providers.llm.modelId,
            ttsProviderId: input.runtimeProfile.providers.tts.providerId,
            ttsModelId: input.runtimeProfile.providers.tts.modelId,
          }),
        ],
      );
      return map(result.rows[0], true);
    } catch (error) {
      if (error.code !== '23505') throw error;
      const raced = await client.query(
        `SELECT * FROM call_sessions WHERE telephony_account_id=$1 AND provider_call_id=$2`,
        [input.call.telephonyAccountId, input.call.providerCallId],
      );
      if (!raced.rowCount) throw error;
      assertSameCall(raced.rows[0], input);
      return map(raced.rows[0], false);
    }
  });
}

export function loadVoiceMediaCallSession(callId, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withAuthServiceContext;
  return contextRunner(async (client) => {
    const result = await client.query(
      `SELECT id,tenant_id,workspace_id,provider_call_id,agent_id,from_number,to_number,direction,status,provider_metadata
         FROM call_sessions
        WHERE id=$1 AND status='connected' AND ended_at IS NULL`,
      [callId],
    );
    if (!result.rowCount) {
      throw new AppError(404, 'Active voice call session was not found', 'VOICE_MEDIA_CALL_NOT_FOUND');
    }
    return map(result.rows[0], false);
  });
}

export function saveVoiceCallPreCallResult(callId, preCall, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withAuthServiceContext;
  return contextRunner(async (client) => {
    const result = await client.query(
      `UPDATE call_sessions
          SET provider_metadata=jsonb_set(COALESCE(provider_metadata,'{}'::jsonb),'{preCall}',$2::jsonb,true)
        WHERE id=$1 AND ended_at IS NULL
        RETURNING *`,
      [callId, JSON.stringify(preCall)],
    );
    if (!result.rowCount) throw new AppError(404, 'Active call session was not found', 'VOICE_CALL_SESSION_NOT_FOUND');
    return map(result.rows[0], false);
  });
}

export class ActiveCallSessionStore {
  #sessions = new Map();

  constructor(options = {}) {
    this.ttlMs = (options.ttlSeconds ?? env.VOICE_CALL_SESSION_TTL_SECONDS) * 1000;
    this.now = options.now ?? Date.now;
  }

  add(callId, controller) {
    if (!callId || !controller) throw new TypeError('Call ID and controller are required');
    if (this.#sessions.has(callId)) throw new AppError(409, 'Call session is already active', 'VOICE_CALL_ALREADY_ACTIVE');
    this.#sessions.set(callId, { controller, expiresAt: this.now() + this.ttlMs });
    return controller;
  }

  get(callId, options = {}) {
    const entry = this.#sessions.get(callId);
    if (!entry) return null;
    const now = options.now ?? this.now();
    if (entry.expiresAt <= now) {
      this.#sessions.delete(callId);
      return null;
    }
    if (options.touch !== false) entry.expiresAt = now + this.ttlMs;
    return entry.controller;
  }

  delete(callId) {
    return this.#sessions.delete(callId);
  }

  deleteIf(callId, controller) {
    const entry = this.#sessions.get(callId);
    if (!entry || entry.controller !== controller) return false;
    return this.#sessions.delete(callId);
  }

  sweep(now = this.now()) {
    const expired = [];
    for (const [callId, entry] of this.#sessions) {
      if (entry.expiresAt <= now) {
        expired.push({ callId, controller: entry.controller });
        this.#sessions.delete(callId);
      }
    }
    return expired;
  }

  get size() { return this.#sessions.size; }
}

export const activeCallSessions = new ActiveCallSessionStore();
