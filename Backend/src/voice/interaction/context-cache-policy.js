import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { cachePolicies, resolveInteractionConfiguration } from './interaction-config.js';

function required(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9._:@+\/-]+$/.test(normalized)) {
    const error = new TypeError(`${field} is required to build an isolated conversation key`);
    error.code = 'VOICE_CONTEXT_SCOPE_INVALID';
    error.field = field;
    throw error;
  }
  return normalized;
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safePrefix(value) {
  return String(value ?? 'zea-voice').trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'zea-voice';
}

export function buildTenantIsolatedContextKey(scope, options = {}) {
  const tenantId = required(scope.tenantId, 'tenantId');
  const workspaceId = required(scope.workspaceId, 'workspaceId');
  const agentId = required(scope.agentId, 'agentId');
  const contextId = required(scope.contextId, 'contextId');
  const isolationDigest = digest(JSON.stringify({ tenantId, workspaceId, agentId, contextId }));
  const base = `${safePrefix(options.prefix ?? env.QUEUE_PREFIX)}:voice:conversation:v1:${tenantId}:${workspaceId}:${agentId}:${isolationDigest}`;
  if (options.sessionId) return `${base}:session:${digest(required(options.sessionId, 'callId')).slice(0, 32)}`;
  return base;
}

export function createContextCachePolicy({ runtimeProfile, call, contextResolution }, options = {}) {
  const interaction = resolveInteractionConfiguration({
    ...runtimeProfile?.agent?.settings,
    ...runtimeProfile?.agent?.speech?.interaction,
  });
  const scope = {
    tenantId: runtimeProfile?.agent?.tenantId,
    workspaceId: runtimeProfile?.agent?.workspaceId,
    agentId: runtimeProfile?.agent?.id,
    contextId: contextResolution?.contextId,
  };
  const common = {
    policy: interaction.cachePolicy,
    contextSource: contextResolution?.source ?? null,
  };
  if (interaction.cachePolicy === cachePolicies.DISABLED) {
    return Object.freeze({
      ...common, scope: 'disabled', key: null, ttlSeconds: 0,
      readEnabled: false, writeEnabled: false, crossCall: false, deleteOnCallEnd: false,
    });
  }
  if (interaction.cachePolicy === cachePolicies.SESSION_ONLY) {
    return Object.freeze({
      ...common,
      scope: 'session',
      key: buildTenantIsolatedContextKey(scope, {
        prefix: options.prefix,
        sessionId: call?.id,
      }),
      ttlSeconds: options.sessionTtlSeconds ?? env.VOICE_CALL_SESSION_TTL_SECONDS,
      readEnabled: true,
      writeEnabled: true,
      crossCall: false,
      deleteOnCallEnd: true,
    });
  }
  return Object.freeze({
    ...common,
    scope: 'persistent',
    key: buildTenantIsolatedContextKey(scope, { prefix: options.prefix }),
    ttlSeconds: options.persistentTtlSeconds ?? env.VOICE_CONTEXT_CACHE_TTL_SECONDS,
    readEnabled: true,
    writeEnabled: true,
    crossCall: true,
    deleteOnCallEnd: false,
  });
}

export function publicContextCacheMetadata(descriptor) {
  return Object.freeze({
    policy: descriptor.policy,
    scope: descriptor.scope,
    ttlSeconds: descriptor.ttlSeconds,
    readEnabled: descriptor.readEnabled,
    writeEnabled: descriptor.writeEnabled,
    crossCall: descriptor.crossCall,
    deleteOnCallEnd: descriptor.deleteOnCallEnd,
  });
}

