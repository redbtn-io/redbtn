/**
 * Crypto utilities for AI package
 * Compatible with webapp's encryption format (iv:authTag:ciphertext)
 */
import { createHash, createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer | null {
  const keySource = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!keySource) return null;
  return createHash('sha256').update(keySource).digest();
}

export function isEncrypted(value: string): boolean {
  if (!value || !value.includes(':')) return false;
  const parts = value.split(':');
  return parts.length === 3;
}

export function decrypt(encryptedValue: string): string {
  if (!encryptedValue) return '';
  if (!isEncrypted(encryptedValue)) return encryptedValue;
  const parts = encryptedValue.split(':');
  const [ivBase64, authTagBase64, ciphertext] = parts;
  try {
    const key = getEncryptionKey();
    if (!key) {
      console.warn('[Crypto] No encryption key available, returning value as-is');
      return encryptedValue;
    }
    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (_error) {
    console.warn('[Crypto] Failed to decrypt value, returning as-is');
    return encryptedValue;
  }
}

export function decryptHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const decrypted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    decrypted[key] = isEncrypted(value) ? decrypt(value) : value;
  }
  return decrypted;
}
