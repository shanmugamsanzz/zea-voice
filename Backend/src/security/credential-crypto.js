import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';

function encryptionKey() {
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    throw new AppError(503, 'Credential encryption is not configured', 'CREDENTIAL_ENCRYPTION_NOT_CONFIGURED');
  }
  const key = Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) {
    throw new AppError(503, 'Credential encryption key must be 32 bytes encoded as base64', 'INVALID_CREDENTIAL_ENCRYPTION_KEY');
  }
  return key;
}

export function encryptCredential(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptCredential(payload) {
  const [version, ivValue, tagValue, ciphertextValue] = payload.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) {
    throw new AppError(500, 'Stored credential is invalid', 'INVALID_STORED_CREDENTIAL');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Stored credential could not be decrypted', 'CREDENTIAL_DECRYPTION_FAILED');
  }
}
