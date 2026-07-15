import crypto from 'node:crypto';

export function generateOpaqueToken() {
  return crypto.randomBytes(48).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}
