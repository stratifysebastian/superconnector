import type { ServerContext } from '@/server/context';
import { readLimitedText } from './common';

const MAX_BODY = 10 * 1024;
const ALLOWED_HTTPS_ORIGINS = new Set(['https://claude.ai', 'https://claude.com']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);
export const MAX_CLIENTS = 200;
const GRANTS = ['authorization_code', 'refresh_token'];

function err(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

export function isAllowedRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || raw.includes('#') || u.username || u.password) return false;
  if (ALLOWED_HTTPS_ORIGINS.has(u.origin)) return true;
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname) && u.port !== '';
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** POST /register (RFC 7591), public clients only. */
export async function handleRegister(ctx: ServerContext, req: Request): Promise<Response> {
  const text = await readLimitedText(req, MAX_BODY);
  if (text === null) return err(413, 'invalid_client_metadata', 'Request body too large');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return err(400, 'invalid_client_metadata', 'Body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return err(400, 'invalid_client_metadata', 'Body must be a JSON object');
  }
  const b = body as Record<string, unknown>;

  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5) {
    return err(400, 'invalid_redirect_uri', 'redirect_uris must contain 1 to 5 entries');
  }
  if (!uris.every(isAllowedRedirectUri)) {
    return err(400, 'invalid_redirect_uri', 'redirect_uris contains a URI that is not permitted');
  }
  const redirectUris = [...new Set(uris as string[])];

  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') {
    return err(400, 'invalid_client_metadata', 'Only token_endpoint_auth_method "none" is supported');
  }
  if (b.grant_types !== undefined && (!isStringArray(b.grant_types) || !b.grant_types.every((g) => GRANTS.includes(g)))) {
    return err(400, 'invalid_client_metadata', 'Unsupported grant_types');
  }
  if (b.response_types !== undefined && (!isStringArray(b.response_types) || !b.response_types.every((r) => r === 'code'))) {
    return err(400, 'invalid_client_metadata', 'Unsupported response_types');
  }
  let clientName: string | undefined;
  if (b.client_name !== undefined) {
    if (typeof b.client_name !== 'string') return err(400, 'invalid_client_metadata', 'client_name must be a string');
    clientName = b.client_name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) || undefined;
  }

  if ((await ctx.store.oauth.countClients()) >= MAX_CLIENTS) {
    return err(400, 'invalid_client_metadata', 'Client registration limit reached');
  }

  const { clientId } = await ctx.store.oauth.createClient({ redirectUris, clientName });
  return new Response(
    JSON.stringify({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(clientName ? { client_name: clientName } : {}),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: GRANTS,
      response_types: ['code'],
    }),
    { status: 201, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
  );
}
