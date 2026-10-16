/** Implemented by src/lib/crypto.ts (T0.1). The store depends only on this interface. */
export interface Cipher {
  /** AES-256-GCM; returns `v1:<base64url iv>.<base64url ciphertext+tag>`. */
  encrypt(plaintext: string): string;
  /** Throws on tamper, wrong key or unknown version. */
  decrypt(ciphertext: string): string;
}
