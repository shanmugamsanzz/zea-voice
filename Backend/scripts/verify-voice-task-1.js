import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
process.env.PUBLIC_BASE_URL = 'https://api.voice.zeacrm.com';
process.env.CREDENTIAL_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef';

const { validateIncomingPlivoCall } = await import('../src/voice/plivo-answer.service.js');
const { plivoAnswerPayloadSchema } = await import('../src/voice/voice.schemas.js');
const { validatePlivoSignature } = await import('../src/telephony/plivo-webhook.service.js');

const payload = {
  CallUUID: 'call-uuid-1',
  From: '+919876543210',
  To: '+918035313119',
  Direction: 'inbound',
  CallStatus: 'in-progress',
};
const nonce = 'voice-task-one';
const token = 'plivo-auth-token';
const url = `${process.env.PUBLIC_BASE_URL}/webhooks/plivo/answer`;
const values = Object.entries(payload).sort(([left], [right]) => left.localeCompare(right))
  .map(([key, value]) => `${key}${value}`).join('');
const signature = crypto.createHmac('sha256', token).update(`${url}?${values}.${nonce}`).digest('base64');
const resolvedPlatformNumbers = [];
const dependencies = {
  loadCalledNumberAccount: async (number) => {
    resolvedPlatformNumbers.push(number);
    return ({
    phone_number_id: '00000000-0000-4000-8000-000000000001',
    telephony_account_id: '00000000-0000-4000-8000-000000000002',
    phone_status: 'active',
    account_status: 'connected',
    });
  },
  authToken: token,
  answerUrl: url,
};

const validated = await validateIncomingPlivoCall({ payload, rawPayload: payload, nonce, signature }, dependencies);
assert.equal(validated.providerCallId, payload.CallUUID);
assert.equal(validated.from, payload.From);
assert.equal(validated.to, payload.To);
assert.equal(resolvedPlatformNumbers[0], payload.To);

const outboundPayload = {
  ...payload, CallUUID: 'call-uuid-outbound', From: payload.To, To: payload.From, Direction: 'outbound',
};
const outboundValues = Object.entries(outboundPayload).sort(([left], [right]) => left.localeCompare(right))
  .map(([key, value]) => `${key}${value}`).join('');
const outboundSignature = crypto.createHmac('sha256', token)
  .update(`${url}?${outboundValues}.${nonce}`).digest('base64');
const outbound = await validateIncomingPlivoCall({
  payload: outboundPayload, rawPayload: outboundPayload, nonce, signature: outboundSignature,
}, dependencies);
assert.equal(outbound.direction, 'outbound');
assert.equal(resolvedPlatformNumbers.at(-1), outboundPayload.From);

const rawPlivoPayload = {
  ...payload,
  From: '919876543210',
  To: '918035313119',
};
const parsedPlivoPayload = plivoAnswerPayloadSchema.parse(rawPlivoPayload);
const rawValues = Object.entries(rawPlivoPayload).sort(([left], [right]) => left.localeCompare(right))
  .map(([key, value]) => `${key}${value}`).join('');
const rawSignature = crypto.createHmac('sha256', token).update(`${url}?${rawValues}.${nonce}`).digest('base64');
const normalized = await validateIncomingPlivoCall({
  payload: parsedPlivoPayload,
  rawPayload: rawPlivoPayload,
  nonce,
  signature: rawSignature,
}, dependencies);
assert.equal(normalized.from, '+919876543210');
assert.equal(normalized.to, '+918035313119');

const mainToken = 'plivo-main-auth-token';
const mainSignature = crypto.createHmac('sha256', mainToken).update(`${url}?${values}.${nonce}`).digest('base64');
const validatedByMainAccount = await validateIncomingPlivoCall({
  payload,
  rawPayload: payload,
  nonce,
  signature: 'invalid-associated-signature',
  mainSignature,
}, { ...dependencies, mainAuthToken: mainToken });
assert.equal(validatedByMainAccount.providerCallId, payload.CallUUID);

const mixedCasePayload = { lower: 'one', Upper: 'two' };
const bytewiseValues = Object.entries(mixedCasePayload).sort(([left], [right]) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}).map(([key, value]) => `${key}${value}`).join('');
const bytewiseSignature = crypto.createHmac('sha256', token)
  .update(`${url}?${bytewiseValues}.${nonce}`).digest('base64');
assert.equal(validatePlivoSignature(url, nonce, bytewiseSignature, token, mixedCasePayload), true);

const callbackUrl = `${url}?attempt_id=00000000-0000-4000-8000-000000000001`;
const callbackSignature = crypto.createHmac('sha256', token)
  .update(`${callbackUrl}.${bytewiseValues}.${nonce}`).digest('base64');
assert.equal(validatePlivoSignature(callbackUrl, nonce, callbackSignature, token, mixedCasePayload), true);

assert.equal(plivoAnswerPayloadSchema.safeParse({ ...payload, To: 'not-a-number' }).success, false);

await assert.rejects(
  validateIncomingPlivoCall({ payload, rawPayload: payload, nonce, signature: 'invalid' }, dependencies),
  (error) => error.code === 'PLIVO_SIGNATURE_INVALID',
);

console.log(JSON.stringify({ success: true, task: 'Voice Task 1 - receive and validate Plivo call' }));
