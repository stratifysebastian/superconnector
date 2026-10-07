import type { LogEvent, Logger } from "@/core/contracts/tool";

const REDACTED = "[redacted]";
const MAX_STR = 200;
const MAX_DEPTH = 6;

const ALLOWED = new Set(["tool", "account", "durationms", "outcome", "msg", "status", "kind"]);
const SENSITIVE = [
  "token", "secret", "password", "authorization", "cookie", "code", "verifier",
  "body", "content", "refresh", "access", "key", "snippet", "html", "plaintext",
  "raw", "attachment",
];

function sensitiveKey(k: string): boolean {
  const l = k.toLowerCase();
  if (ALLOWED.has(l)) return false;
  return SENSITIVE.some((s) => l.includes(s));
}

const WHOLE_PATTERNS = [/^ya29\./, /^1\/\//, /^Bearer\s/i];
const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
// Token-looking fragments embedded in longer text (e.g. error messages).
const EMBEDDED = [
  /ya29\.[\w.-]+/g,
  /\b1\/\/[\w./-]+/g,
  /Bearer\s+[\w.~+/=-]+/gi,
  /\b[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g,
];

function redactString(s: string): string {
  if (WHOLE_PATTERNS.some((p) => p.test(s)) || (s.length > 40 && JWT_RE.test(s))) return REDACTED;
  let out = s;
  for (const p of EMBEDDED) out = out.replace(p, REDACTED);
  if (out.length > MAX_STR) out = out.slice(0, MAX_STR) + "…[truncated]";
  return out;
}

function walk(v: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof v === "string") return redactString(v);
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "function" || typeof v === "symbol") return "[unserializable]";
  const obj = v as object;
  if (depth > MAX_DEPTH) return "[depth]";
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);
  try {
    if (obj instanceof Error) {
      return { name: redactString(obj.name), message: redactString(obj.message) };
    }
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
    if (Array.isArray(obj)) return obj.map((x) => walk(x, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      let val: unknown;
      try {
        val = (obj as Record<string, unknown>)[k];
      } catch {
        val = "[unreadable]";
      }
      out[k] = sensitiveKey(k) ? REDACTED : walk(val, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(obj); // only ancestors count as cycles
  }
}

/** Returns a deep copy safe to log: sensitive keys dropped, token-like values and long strings scrubbed. */
export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}

type Level = "info" | "warn" | "error";

export function createLogger(sink?: (line: string) => void): Logger {
  const emit = (level: Level, e: LogEvent): void => {
    const fields = (redact(e) ?? {}) as Record<string, unknown>;
    delete fields.level;
    delete fields.ts;
    const ts = new Date().toISOString();
    let line: string;
    try {
      line = JSON.stringify({ level, ts, ...fields });
    } catch {
      line = JSON.stringify({ level, ts, msg: "[unserializable]" });
    }
    if (sink) sink(line);
    else if (level === "error") console.error(line);
    else console.log(line);
  };
  return {
    info: (e) => emit("info", e),
    warn: (e) => emit("warn", e),
    error: (e) => emit("error", e),
  };
}
