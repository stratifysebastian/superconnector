import { hkdfSync } from 'node:crypto';

/** One subkey per purpose, so a token minted for one use can never verify as another (ADR-7). */
export type KeyPurpose = 'session' | 'csrf' | 'google-pkce' | 'oidc-cookie';

const SALT = 'superconnector/v1';

/** HKDF-SHA256 subkey (32 bytes) derived from SESSION_SECRET with the purpose as the info label. */
export function deriveKey(secret: string, purpose: KeyPurpose): Buffer {
  if (!secret) throw new Error('A secret is required to derive keys');
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(SALT, 'utf8'), Buffer.from(purpose, 'utf8'), 32),
  );
}

/** Same subkey as a string, for HMAC helpers that take a string secret. */
export function deriveKeyString(secret: string, purpose: KeyPurpose): string {
  return deriveKey(secret, purpose).toString('base64url');
}
