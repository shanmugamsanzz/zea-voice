import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

const dummyPasswordHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), env.PASSWORD_BCRYPT_ROUNDS);

export function hashPassword(password) {
  return bcrypt.hash(password, env.PASSWORD_BCRYPT_ROUNDS);
}

export function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

export function performDummyPasswordCheck(password) {
  return bcrypt.compare(password, dummyPasswordHash);
}
