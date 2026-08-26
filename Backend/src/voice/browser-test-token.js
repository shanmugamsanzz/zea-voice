import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';

const purpose = 'browser_test_media';

function secret(options = {}) {
  const value = options.secret ?? env.VOICE_MEDIA_SIGNING_SECRET ?? env.CREDENTIAL_ENCRYPTION_KEY;
  if (!value) {
    throw new AppError(503, 'Browser test media signing is not configured',
      'BROWSER_TEST_SIGNING_NOT_CONFIGURED');
  }
  return value;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signature(payload, options) {
  return crypto.createHmac('sha256', secret(options)).update(payload).digest('base64url');
}

export function hashBrowserTestNonce(nonce) {
  return crypto.createHash('sha256').update(String(nonce)).digest('hex');
}

export function createBrowserTestMediaToken(session, options = {}) {
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const ttlSeconds = options.ttlSeconds ?? env.BROWSER_TEST_TOKEN_TTL_SECONDS;
  const payload = encode({
    purpose,
    callId: session.callId,
    testCallId: session.testCallId,
    tenantId: session.tenantId,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    userId: session.userId,
    nonce: session.nonce,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  });
  return `${payload}.${signature(payload, options)}`;
}

export function validateBrowserTestMediaToken(token, expectedCallId, options = {}) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError(401, 'Browser test media token is invalid', 'BROWSER_TEST_TOKEN_INVALID');
  }
  const supplied = Buffer.from(parts[1]);
  const expected = Buffer.from(signature(parts[0], options));
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw new AppError(401, 'Browser test media token signature is invalid', 'BROWSER_TEST_TOKEN_INVALID');
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch {
    throw new AppError(401, 'Browser test media token payload is invalid', 'BROWSER_TEST_TOKEN_INVALID');
  }
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const required = ['callId', 'testCallId', 'tenantId', 'workspaceId', 'agentId', 'userId', 'nonce'];
  if (payload.purpose !== purpose || required.some((key) => !payload[key])
    || !Number.isInteger(payload.exp) || payload.exp <= nowSeconds
    || (payload.iat && payload.iat > nowSeconds + 30)) {
    throw new AppError(401, 'Browser test media token is invalid or expired',
      payload.exp <= nowSeconds ? 'BROWSER_TEST_TOKEN_EXPIRED' : 'BROWSER_TEST_TOKEN_INVALID');
  }
  if (expectedCallId && payload.callId !== expectedCallId) {
    throw new AppError(401, 'Browser test media token does not match the call',
      'BROWSER_TEST_TOKEN_CALL_MISMATCH');
  }
  return Object.freeze(payload);
}
