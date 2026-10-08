import { describe, expect, it } from "vitest";
import { createLogger, redact } from "@/lib/log";

function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger((l) => lines.push(l)) };
}

const KEYS = [
  "token", "accessToken", "refresh_token", "client_secret", "password", "Authorization",
  "cookie", "code", "verifier", "body", "htmlBody", "content", "snippet", "plaintext",
  "raw", "attachmentData", "apiKey", "html",
];

describe("redact", () => {
  it("never emits seeded secrets under sensitive keys at any nesting", () => {
    const { lines, log } = capture();
    let n = 0;
    for (const k of KEYS) {
      const s = `FAKE_SECRET_VALUE_${n++}`;
      log.info({ msg: "m", [k]: s });
      log.info({ msg: "m", a: { b: { [k]: s } } });
      log.info({ msg: "m", list: [{ x: [{ [k]: s }] }] });
      log.info({ msg: "m", [k]: { nested: s, arr: [s] } });
      const out = lines.splice(0).join("\n");
      expect(out).not.toContain(s);
      expect(out).toContain("[redacted]");
    }
  });
  it("scrubs Error messages and drops stacks", () => {
    const { lines, log } = capture();
    log.error({ msg: "fail", err: new Error("boom ya29.FAKETOKENVALUE123 Bearer FAKEBEARER.xyz") });
    const out = lines[0]!;
    expect(out).not.toContain("FAKETOKENVALUE123");
    expect(out).not.toContain("FAKEBEARER");
    expect(out).not.toContain("at ");
    expect(JSON.parse(out).err.name).toBe("Error");
  });
  it("redacts token-shaped values under innocent keys", () => {
    const jwt = "aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbb.cccccccccccccccc";
    const r = redact({
      a: "ya29.FAKE", b: "1//FAKEREFRESH", c: "Bearer FAKE", d: jwt, e: "short.a.b",
    }) as Record<string, string>;
    expect(r.a).toBe("[redacted]");
    expect(r.b).toBe("[redacted]");
    expect(r.c).toBe("[redacted]");
    expect(r.d).toBe("[redacted]");
    expect(r.e).toBe("short.a.b");
  });
  it("keeps allowed fields", () => {
    const { lines, log } = capture();
    log.info({
      tool: "gmail_search", account: "work", durationMs: 12, outcome: "ok",
      msg: "done", status: 200, kind: "reauth",
    });
    const o = JSON.parse(lines[0]!);
    expect(o).toMatchObject({
      level: "info", tool: "gmail_search", account: "work", durationMs: 12,
      outcome: "ok", msg: "done", status: 200, kind: "reauth",
    });
    expect(typeof o.ts).toBe("string");
  });
  it("truncates long strings", () => {
    const r = redact({ note: "a".repeat(500) }) as { note: string };
    expect(r.note.endsWith("…[truncated]")).toBe(true);
    expect(r.note.length).toBeLessThan(230);
  });
  it("handles cycles and depth", () => {
    const a: Record<string, unknown> = { name: "x" };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect((redact(a) as Record<string, unknown>).self).toBe("[circular]");
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: "v" } } } } } } } };
    expect(JSON.stringify(redact(deep))).toContain("[depth]");
    const { lines, log } = capture();
    log.warn({ msg: "c", a });
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });
  it("emits one valid JSON line per event, level/ts first, not overridable", () => {
    const { lines, log } = capture();
    log.info({ msg: "a\nb", level: "x", ts: "y" });
    log.warn({ msg: "w" });
    log.error({ msg: "e" });
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l.includes("\n")).toBe(false);
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(["info", "warn", "error"]);
    expect(lines[0]!.startsWith('{"level":"info","ts":')).toBe(true);
  });
});
