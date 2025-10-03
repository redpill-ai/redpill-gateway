import crypto from 'crypto';

export function hash(payload: string): string {
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}
