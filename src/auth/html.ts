export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE =
  'body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}' +
  'button{font:inherit;padding:.5rem 1rem;margin-right:.5rem;cursor:pointer}dl{margin:1rem 0}dt{font-weight:600}dd{margin:0 0 .5rem}';

/** Security headers for every HTML page we render. */
export function pageHeaders(extra: Record<string, string> = {}): Headers {
  const h = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  });
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

/** `bodyHtml` must already be escaped by the caller. */
export function htmlResponse(status: number, title: string, bodyHtml: string, headers?: Headers): Response {
  const doc =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${bodyHtml}</body></html>`;
  return new Response(doc, { status, headers: headers ?? pageHeaders() });
}

export function messagePage(
  status: number,
  title: string,
  message: string,
  link?: { href: string; text: string },
  headers?: Headers,
): Response {
  const a = link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a></p>` : '';
  return htmlResponse(status, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${a}`, headers);
}
