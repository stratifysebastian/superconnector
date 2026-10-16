import { NextResponse, type NextRequest } from 'next/server';
import { getAdminSession } from '@/auth/session';
import { startIntuitAuth } from '@/intuit/oauth';
import { getServerContext } from '@/server/context';

export const dynamic = 'force-dynamic';

function noStore(r: NextResponse): NextResponse {
  r.headers.set('Cache-Control', 'no-store');
  return r;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Cross-site navigations must not start a connect flow; a missing header, same-origin and none are fine.
  if (req.headers.get('sec-fetch-site') === 'cross-site') {
    return noStore(new NextResponse('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
  }
  const ctx = await getServerContext();
  const session = await getAdminSession();
  if (!session) return noStore(NextResponse.redirect(new URL('/signin?next=/connect', ctx.baseUrl), 302));

  const orgId = req.nextUrl.searchParams.get('org');
  const accountId = req.nextUrl.searchParams.get('account') ?? undefined;
  const org = orgId ? await ctx.store.orgClients.get(orgId) : null;
  if (!orgId || !org || org.provider !== 'intuit') {
    return noStore(NextResponse.json({ error: 'Unknown Intuit app' }, { status: 404 }));
  }

  if (accountId) {
    const acct = (await ctx.store.accounts.list()).find((a) => a.id === accountId);
    if (!acct || acct.provider !== 'intuit') return noStore(NextResponse.json({ error: 'Unknown account' }, { status: 404 }));
  }

  const url = await startIntuitAuth({
    store: ctx.store,
    orgClientId: orgId,
    orgClient: org,
    ...(accountId ? { accountId } : {}),
    redirectUri: `${ctx.baseUrl}/api/intuit/callback`,
  });
  return noStore(NextResponse.redirect(url, 302));
}
