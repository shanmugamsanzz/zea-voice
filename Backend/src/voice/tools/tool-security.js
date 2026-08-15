import dns from 'node:dns/promises';
import net from 'node:net';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errors.js';

const forbiddenHeaderNames = new Set([
  'connection', 'content-length', 'cookie', 'forwarded', 'host', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto',
]);
const secretHeaderName = /(authorization|api[-_]?key|token|secret|password|credential)/i;

function ipv4Blocked(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function ipBlocked(address) {
  const normalized = String(address ?? '').trim().toLowerCase().split('%')[0];
  const family = net.isIP(normalized);
  if (family === 4) return ipv4Blocked(normalized);
  if (family !== 6) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  return normalized === '::' || normalized === '::1'
    || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:');
}

export function validateToolHeaders(headers, { secret = false } = {}) {
  const entries = Object.entries(headers ?? {});
  if (entries.length > 32) throw new AppError(400, 'Tool headers cannot exceed 32 entries', 'VOICE_TOOL_HEADERS_LIMIT');
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName).trim();
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || forbiddenHeaderNames.has(lower)) {
      throw new AppError(400, `Tool header is not allowed: ${name || '(empty)'}`, 'VOICE_TOOL_HEADER_INVALID');
    }
    if (!secret && secretHeaderName.test(name)) {
      throw new AppError(400, `Store ${name} as a secret header`, 'VOICE_TOOL_SECRET_HEADER_REQUIRED');
    }
    if (String(rawValue).length > 4096 || /[\r\n]/.test(String(rawValue))) {
      throw new AppError(400, `Tool header value is invalid: ${name}`, 'VOICE_TOOL_HEADER_VALUE_INVALID');
    }
  }
}

export async function validateWebhookEndpoint(endpoint, options = {}) {
  let url;
  try { url = new URL(String(endpoint ?? '')); } catch {
    throw new AppError(400, 'Webhook URL must be a valid absolute URL', 'VOICE_TOOL_ENDPOINT_INVALID');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new AppError(400, 'Webhook URL must use HTTP or HTTPS without embedded credentials', 'VOICE_TOOL_ENDPOINT_INVALID');
  }
  if (env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new AppError(400, 'Webhook URL must use HTTPS in production', 'VOICE_TOOL_HTTPS_REQUIRED');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new AppError(400, 'Webhook URL cannot target a local or private host', 'VOICE_TOOL_PRIVATE_ENDPOINT');
  }
  if (net.isIP(hostname) && ipBlocked(hostname)) {
    throw new AppError(400, 'Webhook URL cannot target a local or private address', 'VOICE_TOOL_PRIVATE_ENDPOINT');
  }
  if (options.resolveDns === true) {
    let addresses;
    try {
      const lookup = options.lookupFn ?? dns.lookup;
      const result = await lookup(hostname, { all: true, verbatim: true });
      addresses = Array.isArray(result) ? result : [result];
    } catch {
      throw new AppError(502, 'Webhook hostname could not be resolved', 'VOICE_TOOL_DNS_FAILED');
    }
    if (!addresses.length || addresses.some((entry) => ipBlocked(entry?.address ?? entry))) {
      throw new AppError(400, 'Webhook hostname resolves to a private or reserved address', 'VOICE_TOOL_PRIVATE_ENDPOINT');
    }
  }
  return url.toString();
}

function matchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function schemaViolation(value, schema = {}, path = 'arguments') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const allowedTypes = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  if (allowedTypes.length && !allowedTypes.some((type) => matchesType(value, type))) {
    return `${path} does not match the configured type`;
  }
  if (schema.const !== undefined && value !== schema.const) return `${path} does not match the configured value`;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    return `${path} is not an allowed value`;
  }
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return `${path} is too short`;
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return `${path} is too long`;
    if (schema.pattern) {
      try { if (!new RegExp(schema.pattern, 'u').test(value)) return `${path} has an invalid format`; }
      catch { return `${path} has an invalid configured pattern`; }
    }
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return `${path} is below the minimum`;
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return `${path} is above the maximum`;
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return `${path} has too few items`;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return `${path} has too many items`;
    for (let index = 0; index < value.length; index += 1) {
      const violation = schemaViolation(value[index], schema.items, `${path}[${index}]`);
      if (violation) return violation;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    const missing = required.filter((key) => !Object.hasOwn(value, key));
    if (missing.length) return `${path} is missing: ${missing.join(', ')}`;
    if (schema.additionalProperties === false) {
      const extras = Object.keys(value).filter((key) => !Object.hasOwn(schema.properties ?? {}, key));
      if (extras.length) return `${path} contains fields that are not allowed: ${extras.join(', ')}`;
    }
    for (const [key, propertyValue] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties ?? {}, key)) continue;
      const violation = schemaViolation(propertyValue, schema.properties[key], `${path}.${key}`);
      if (violation) return violation;
    }
  }
  for (const child of schema.allOf ?? []) {
    const violation = schemaViolation(value, child, path);
    if (violation) return violation;
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length
    && !schema.anyOf.some((child) => !schemaViolation(value, child, path))) return `${path} matches no allowed schema`;
  return null;
}

export function toolArgumentsMatchSchema(value, schema) {
  return schemaViolation(value, schema) === null;
}

export function validateToolArguments(argumentsValue, schema) {
  const value = argumentsValue ?? {};
  let serialized;
  try { serialized = JSON.stringify(value); } catch {
    throw new AppError(400, 'Tool arguments must be valid JSON', 'VOICE_TOOL_ARGUMENTS_INVALID');
  }
  if (Buffer.byteLength(serialized) > 32768) {
    throw new AppError(400, 'Tool arguments exceed the 32 KB limit', 'VOICE_TOOL_ARGUMENTS_TOO_LARGE');
  }
  const violation = schemaViolation(value, schema);
  if (violation) throw new AppError(400, `Tool arguments are invalid: ${violation}`, 'VOICE_TOOL_ARGUMENTS_INVALID');
  return value;
}
