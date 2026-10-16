import { NextResponse, type NextRequest } from 'next/server';
import { getAdminSession } from '@/auth/session';
import { ALL_SCOPES, missingProducts } from '@/core/products';
import { derivePkceVerifier, exchangeCode, GoogleOAuthError, readIdToken } from '@/google/oauth';
import { hashToken } from '@/lib/crypto';
import { getServerContext } from '@/server/context';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await getServerContext();
  const redirect = (path: string): NextResponse => {
    const r = NextResponse.redirect(new URL(path, ctx.baseUrl), 302);
    r.headers.set('Cache-Control', 'no-store');
    return r;
  };
  const fail = async (error: string, account = 'unknown', detail?: string): Promise<NextResponse> => {
    await ctx.store.audit
      .write({ tool: 'connect', account, outcome: 'rejected', detail: detail ?? error })
      .catch(() => undefined);
    ctx.log.warn({ msg: 'google connect rejected', tool: 'connect', outcome: error });
    return redirect(`/connect?error=${encodeURIComponent(error)}`);
  };

  const session = await getAdminSession();
  if (!session) return redirect('/signin?next=/connect');

  const sp = req.nextUrl.searchParams;
  const state = sp.get('state');
  const code = sp.get('code');
  const stored = state ? await ctx.store.oauth.consumeState(hashToken(state)) : null;
  if (!state || !stored || stored.expiresAt <= Date.now()) return fail('state');
  if (sp.get('error') || !code) return fail('denied');

  const org = await ctx.store.orgClients.get(stored.orgClientId);
  if (!org) return fail('state');

  try {
    const tokens = await exchangeCode({
      orgClient: org,
      code,
      codeVerifier: derivePkceVerifier(state, ctx.env.SESSION_SECRET),
      redirectUri: `${ctx.baseUrl}/api/google/callback`,
    });
    if (!tokens.id_token) return fail('invalid_token', org.label, 'no id_token');
    const who = readIdToken(tokens.id_token, org);

    if (stored.accountId) {
      const existing = (await ctx.store.accounts.list()).find((a) => a.id === stored.accountId);
      if (!existing || existing.email.toLowerCase() !== who.email) return fail('wrong_account', org.label);
    }
    if (!tokens.refresh_token) return fail('no_refresh_token', org.label);

    const granted = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
    const missing = ALL_SCOPES.some((s) => !granted.includes(s)) ? missingProducts(granted) : [];

    const account = await ctx.store.accounts.upsertOnConnect({
      provider: 'google',
      email: who.email,
      label: org.label,
      orgClientId: org.id,
      grantedScopes: granted,
    });
    await ctx.store.tokens.setRefreshToken(account.id, tokens.refresh_token);
    if (tokens.access_token && typeof tokens.expires_in === 'number') {
      await ctx.store.tokens.setCachedAccess(account.id, tokens.access_token, Date.now() + tokens.expires_in * 1000);
    }
    await ctx.store.accounts.setStatus(account.id, 'active');
    await ctx.store.audit.write({
      tool: 'connect',
      account: org.label,
      outcome: 'ok',
      ...(missing.length ? { detail: `missing: ${missing.join(',')}` } : {}),
    });
    ctx.log.info({ msg: 'google account connected', tool: 'connect', account: org.label, outcome: 'ok' });
    let qs = `connected=${encodeURIComponent(account.label)}`;
    if (missing.length) qs += `&missing=${encodeURIComponent(missing.join(','))}`;
    return redirect(`/connect?${qs}`);
  } catch (e) {
    if (e instanceof GoogleOAuthError) {
      return fail(e.kind === 'exchange_failed' ? 'exchange_failed' : 'invalid_token', org.label, e.reason);
    }
    ctx.log.error({ msg: 'google connect failed', tool: 'connect', outcome: 'error' });
    return fail('server_error', org.label);
  }
}
