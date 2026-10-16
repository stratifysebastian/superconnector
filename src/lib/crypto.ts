import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Cipher } from "@/core/contracts/crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

const b64u = (b: Buffer): string => b.toString("base64url");
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

function fromB64u(s: string): Buffer {
  if (!BASE64URL_RE.test(s)) throw new Error("invalid");
  return Buffer.from(s, "base64url");
}

/** Creates an AES-256-GCM cipher. `base64Key` must decode to exactly 32 bytes. */
export function createCipher(base64Key: string): Cipher {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error("Encryption key must be 32 bytes, base64 encoded");
  }
  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final(), c.getAuthTag()]);
      return `${VERSION}:${b64u(iv)}.${b64u(ct)}`;
    },
    decrypt(payload: string): string {
      try {
        if (typeof payload !== "string" || !payload.startsWith(`${VERSION}:`)) {
          throw new Error("invalid");
        }
        const parts = payload.slice(VERSION.length + 1).split(".");
        if (parts.length !== 2) throw new Error("invalid");
        const iv = fromB64u(parts[0]!);
        const data = fromB64u(parts[1]!);
        if (iv.length !== IV_BYTES || data.length < TAG_BYTES) throw new Error("invalid");
        const tag = data.subarray(data.length - TAG_BYTES);
        const ct = data.subarray(0, data.length - TAG_BYTES);
        const d = createDecipheriv("aes-256-gcm", key, iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
      } catch {
        throw new Error("Decryption failed");
      }
    },
  };
}

/** SHA-256 of a token, base64url. For storing token lookups without the token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time string comparison; false on length mismatch. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  // Compare fixed-length digests so timing does not depend on content or length.
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  const eq = timingSafeEqual(ha, hb);
  return eq && Buffer.byteLength(a) === Buffer.byteLength(b);
}

export function hmacSign(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("base64url");
}

export function hmacVerify(secret: string, data: string, sig: string): boolean {
  return timingSafeEqualStr(hmacSign(secret, data), sig);
}
