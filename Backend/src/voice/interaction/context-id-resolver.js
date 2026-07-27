import crypto from 'node:crypto';
import { normalizePhone } from '../../campaigns/csv.js';
import { normalizeContextId } from './interaction-config.js';

const explicitKeys = ['context_id', 'contextId'];
const crmKeys = [
  ['contact_id', 'contact'], ['contactId', 'contact'],
  ['lead_id', 'lead'], ['leadId', 'lead'],
  ['customer_id', 'customer'], ['customerId', 'customer'],
  ['external_contact_id', 'contact'], ['externalContactId', 'contact'],
];

function safeId(value) { return normalizeContextId(value); }

function explicit(context) {
  for (const key of explicitKeys) {
    const value = safeId(context?.[key]);
    if (value) return value;
  }
  return null;
}

function crm(context) {
  for (const [key, kind] of crmKeys) {
    const value = safeId(context?.[key]);
    if (value) return `${kind}:${value}`;
  }
  return null;
}

function phoneIdentity(call) {
  const customerPhone = normalizePhone(call?.direction === 'outbound' ? call?.to : call?.from);
  if (!customerPhone) return null;
  const digest = crypto.createHash('sha256').update(customerPhone).digest('hex').slice(0, 32);
  return `phone:${digest}`;
}

export function resolveCallContextId({ call, runtimeProfile }) {
  const taskContext = call?.providerMetadata?.context ?? {};
  const preCallContext = call?.providerMetadata?.preCall?.context ?? {};
  const direction = call?.direction === 'outbound' ? 'outbound' : 'inbound';
  const candidates = direction === 'outbound'
    ? [
      [explicit(taskContext), 'outbound_context_id'],
      [crm(taskContext), 'outbound_crm_id'],
      [explicit(preCallContext), 'precall_context_id'],
      [crm(preCallContext), 'precall_crm_id'],
    ]
    : [
      [explicit(preCallContext), 'precall_context_id'],
      [crm(preCallContext), 'precall_crm_id'],
    ];
  const selected = candidates.find(([value]) => Boolean(value));
  const identity = selected?.[0] ?? phoneIdentity(call);
  const source = selected?.[1] ?? 'phone_fallback';
  const namespace = safeId(runtimeProfile?.agent?.speech?.interaction?.contextId
    ?? runtimeProfile?.agent?.settings?.contextId);
  if (!identity) {
    const error = new TypeError('A call Context ID could not be resolved');
    error.code = 'VOICE_CONTEXT_ID_UNRESOLVED';
    throw error;
  }
  return Object.freeze({
    contextId: namespace ? `${namespace}:${identity}` : identity,
    identity,
    namespace,
    source,
    direction,
  });
}

