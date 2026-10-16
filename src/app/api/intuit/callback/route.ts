import { NextResponse, type NextRequest } from 'next/server';
import { getAdminSession } from '@/auth/session';
import { QUICKBOOKS_SCOPE } from '@/core/products';
import { REALM_ID_PATTERN } from '@/intuit/endpoints';
import { createIntuitHttp } from '@/intuit/http';
import { exchangeIntuitCode, IntuitOAuthError } from '@/intuit/oauth';
import { fetchCompanyInfo } from '@/intuit/quickbooks';
import { hashToken } from '@/lib/crypto';
import { getServerContext } from '@/server/context';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await getServerContext();
  const redirect = (path: string): NextResponse => {
    const r = NextResponse.redirect(new URL(path, ctx.baseUrl), 302);
    r.headers.set('Cache-Control', 'no-store');
    return r;
  };
  // Audit detail and logs hold a short code only: never a company name, email, realmId, code or token.
  const fail = async (error: string, account = 'unknown'): Promise<NextResponse> => {
    await ctx.store.audit.write({ tool: 'connect', account, outcome: 'rejected', detail: error }).catch(() => undefined);
    ctx.log.warn({ msg: 'intuit connect rejected', tool: 'connect', outcome: error });
    return redirect(`/connect?error=${encodeURIComponent(error)}`);
  };

  const session = await getAdminSession();
  if (!session) return redirect('/signin?next=/connect');

  const sp = req.nextUrl.searchParams;
  const state = sp.get('state');
  const code = sp.get('code');
  const realmId = sp.get('realmId');
  // Single use: the state is deleted as it is read.
  const stored = state ? await ctx.store.oauth.consumeState(hashToken(state)) : null;
  if (!state || !stored || stored.expiresAt <= Date.now()) return fail('state');
  if (sp.get('error') || !code) return fail('denied');

  const org = await ctx.store.orgClients.get(stored.orgClientId);
  if (!org || org.provider !== 'intuit') return fail('state');
  if (!realmId || !REALM_ID_PATTERN.test(realmId)) return fail('no_realm', org.label);

  if (stored.accountId) {
    // Reconnect: it must be the same company, or a different company would take over this account.
    const existing = (await ctx.store.accounts.list()).find((a) => a.id === stored.accountId && a.provider === 'intuit');
    if (!existing) return fail('state', org.label);
    if (existing.realmId !== realmId) return fail('wrong_company', org.label);
  }

  try {
    const tokens = await exchangeIntuitCode({ client: org, code, redirectUri: `${ctx.baseUrl}/api/intuit/callback` });

    let info;
    try {
      const http = createIntuitHttp({
        // The company is not stored yet, so there is nothing to refresh: the fresh token is the only one.
        getAccessToken: async () => tokens.accessToken,
        realmId,
        env: ctx.env.INTUIT_ENV,
        log: ctx.log,
      });
      info = await fetchCompanyInfo(http, realmId);
    } catch {
      return fail('company_info', org.label);
    }
    const name = (info.CompanyName ?? info.LegalName)?.toString().trim().slice(0, 200) || undefined;
    const rawEmail = info.Email?.Address?.toString().trim().toLowerCase();
    const email = rawEmail && rawEmail.length <= 254 && EMAIL_RE.test(rawEmail) ? rawEmail : `realm-${realmId}@intuit.local`;

    const account = await ctx.store.accounts.upsertOnConnect({
      provider: 'intuit',
      email,
      label: org.label,
      orgClientId: org.id,
      grantedScopes: [QUICKBOOKS_SCOPE],
      realmId,
      ...(name ? { companyName: name } : {}),
    });
    await ctx.store.tokens.setRefreshToken(account.id, tokens.refreshToken);
    await ctx.store.tokens.setCachedAccess(account.id, tokens.accessToken, Date.now() + tokens.expiresIn * 1000);
    await ctx.store.accounts.setStatus(account.id, 'active');
    await ctx.store.audit.write({ tool: 'connect', account: account.label, outcome: 'ok' });
    ctx.log.info({ msg: 'intuit company connected', tool: 'connect', account: account.label, outcome: 'ok' });
    return redirect(`/connect?connected=${encodeURIComponent(account.label)}`);
  } catch (e) {
    if (e instanceof IntuitOAuthError) return fail('exchange_failed', org.label);
    ctx.log.error({ msg: 'intuit connect failed', tool: 'connect', outcome: 'error' });
    return fail('server_error', org.label);
  }
}
