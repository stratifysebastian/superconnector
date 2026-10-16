/** Minimal cookie helpers. Every cookie we set is HttpOnly; Secure; SameSite=Lax. */

export function parseCookies(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !out.has(k)) out.set(k, v);
  }
  return out;
}

const SAFE_VALUE = /^[A-Za-z0-9._~-]*$/;

export function serializeCookie(name: string, value: string, opts: { maxAge: number; path: string }): string {
  if (!SAFE_VALUE.test(value)) throw new Error('Cookie value contains unsafe characters');
  return `${name}=${value}; Max-Age=${Math.max(0, Math.floor(opts.maxAge))}; Path=${opts.path}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(name: string, path: string): string {
  return serializeCookie(name, '', { maxAge: 0, path });
}
