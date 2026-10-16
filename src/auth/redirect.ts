/**
 * `next` must be a same-origin relative path. Anything else (absolute URLs, protocol-relative `//host`,
 * backslash tricks, control characters) falls back to `/connect`.
 */
export const DEFAULT_NEXT = '/connect';

export function sanitizeNext(next: string | null | undefined): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > 2048) return DEFAULT_NEXT;
  if (!next.startsWith('/') || next.startsWith('//')) return DEFAULT_NEXT;
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return DEFAULT_NEXT;
  try {
    const u = new URL(next, 'http://relative.invalid');
    if (u.origin !== 'http://relative.invalid') return DEFAULT_NEXT;
  } catch {
    return DEFAULT_NEXT;
  }
  return next;
}
