import { createHash } from 'node:crypto';
import { timingSafeEqualStr } from '@/lib/crypto';

export const MCP_SCOPE = 'mcp';
export const ACCESS_TTL_SECONDS = 3600;
export const REFRESH_TTL_SECONDS = 30 * 24 * 3600;
export const CODE_TTL_SECONDS = 5 * 60;

export const mcpResource = (baseUrl: string): string => `${baseUrl}/api/mcp`;

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export const isValidChallenge = (c: string): boolean => CHALLENGE_RE.test(c);

export function pkceS256Matches(verifier: string, challenge: string): boolean {
  if (!VERIFIER_RE.test(verifier)) return false;
  const computed = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  return timingSafeEqualStr(computed, challenge);
}

/** Reads a request body as text, refusing anything over `max` bytes. Null when too large. */
export async function readLimitedText(req: Request, max: number): Promise<string | null> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > max) return null;
  const text = await req.text();
  return Buffer.byteLength(text, 'utf8') > max ? null : text;
}

/** Parses form-encoded text. Null when any parameter name repeats (RFC 6749 3.2). */
export function parseFormStrict(text: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(text)) {
    if (out.has(k)) return null;
    out.set(k, v);
  }
  return out;
}

export function singleParams(sp: URLSearchParams): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const [k, v] of sp) {
    if (out.has(k)) return null;
    out.set(k, v);
  }
  return out;
}
