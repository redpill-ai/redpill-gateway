import crypto from 'crypto';
import { env } from '../constants';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits for GCM tag

function getDerivedKey(): Buffer {
  return crypto.createHash('sha256').update(env.ENCRYPTION_KEY).digest();
}

export function encryptConfig(plaintext: string): string {
  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  // Use Uint8Array to avoid Buffer type issues
  const cipher = crypto.createCipheriv(
    ALGORITHM,
    new Uint8Array(key),
    new Uint8Array(iv)
  );

  const encryptedBuffer = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  // Format: iv + tag + encrypted as single base64 string
  return Buffer.concat([iv, tag, encryptedBuffer]).toString('base64');
}

export function decryptConfig(encryptedData: string): string {
  if (!encryptedData || typeof encryptedData !== 'string') {
    throw new Error('Invalid encrypted data: must be a non-empty string');
  }

  const data = Buffer.from(encryptedData, 'base64');

  // Check minimum length: iv + tag + at least 1 byte of encrypted data
  if (data.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Invalid encrypted data: too short');
  }

  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

  const key = getDerivedKey();

  // Use createDecipheriv instead of deprecated createDecipher
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    new Uint8Array(key),
    new Uint8Array(iv)
  );
  decipher.setAuthTag(new Uint8Array(tag));

  const decryptedBuffer = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decryptedBuffer.toString('utf8');
}

export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('hex');
}
