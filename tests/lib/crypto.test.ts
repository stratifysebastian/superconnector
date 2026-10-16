import { describe, expect, it } from "vitest";
import {
  createCipher, hashToken, hmacSign, hmacVerify, randomToken, timingSafeEqualStr,
} from "@/lib/crypto";

const key = Buffer.alloc(32, 7).toString("base64");
const otherKey = Buffer.alloc(32, 9).toString("base64");

describe("cipher", () => {
  const c = createCipher(key);
  it("round trips incl. unicode and empty", () => {
    for (const s of ["", "hello", "héllo ✓ 日本語 😀", "x".repeat(5000)]) {
      expect(c.decrypt(c.encrypt(s))).toBe(s);
    }
  });
  it("uses v1 format and fresh IVs", () => {
    const a = c.encrypt("same");
    const b = c.encrypt("same");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1:[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  });
  it("rejects any single flipped byte in iv, ciphertext or tag", () => {
    const p = c.encrypt("secret-ish");
    const [ivS, dataS] = p.slice(3).split(".") as [string, string];
    const iv = Buffer.from(ivS, "base64url");
    const data = Buffer.from(dataS, "base64url");
    for (let i = 0; i < iv.length; i++) {
      const m = Buffer.from(iv);
      m[i]! ^= 1;
      expect(() => c.decrypt(`v1:${m.toString("base64url")}.${dataS}`)).toThrow();
    }
    for (let i = 0; i < data.length; i++) {
      const m = Buffer.from(data);
      m[i]! ^= 1;
      expect(() => c.decrypt(`v1:${ivS}.${m.toString("base64url")}`)).toThrow();
    }
  });
  it("rejects wrong key, unknown version and malformed input", () => {
    const p = c.encrypt("x");
    expect(() => createCipher(otherKey).decrypt(p)).toThrow();
    expect(() => c.decrypt("v2:" + p.slice(3))).toThrow();
    for (const bad of ["", "garbage", "v1:", "v1:abc", "v1:a.b.c", "v1:!!.@@"]) {
      expect(() => c.decrypt(bad)).toThrow("Decryption failed");
    }
  });
  it("rejects bad key length without leaking key material", () => {
    const short = Buffer.alloc(16, 5).toString("base64");
    let msg = "";
    try {
      createCipher(short);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toBe("");
    expect(msg).not.toContain(short);
    expect(() => createCipher("")).toThrow();
  });
});

describe("helpers", () => {
  it("hashToken deterministic base64url", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
    expect(hashToken("abc")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("randomToken length and uniqueness", () => {
    expect(randomToken()).toHaveLength(43);
    expect(randomToken(16)).toHaveLength(22);
    expect(new Set(Array.from({ length: 50 }, () => randomToken())).size).toBe(50);
  });
  it("hmac sign/verify", () => {
    const s = hmacSign("fake-secret", "data");
    expect(hmacVerify("fake-secret", "data", s)).toBe(true);
    expect(hmacVerify("fake-secret", "data2", s)).toBe(false);
    expect(hmacVerify("other", "data", s)).toBe(false);
    expect(hmacVerify("fake-secret", "data", "short")).toBe(false);
  });
  it("timingSafeEqualStr", () => {
    expect(timingSafeEqualStr("a", "a")).toBe(true);
    expect(timingSafeEqualStr("a", "b")).toBe(false);
    expect(timingSafeEqualStr("a", "ab")).toBe(false);
    expect(timingSafeEqualStr("", "")).toBe(true);
  });
});
