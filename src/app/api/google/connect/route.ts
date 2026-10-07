import { NextResponse, type NextRequest } from 'next/server';
import { getAdminSession } from '@/auth/session';
import { startGoogleAuth } from '@/google/oauth';
import { getServerContext } from '@/server/context';

export const dynamic = 'force-dynamic';

function noStore(r: NextResponse): NextResponse {
  r.headers.set('Cache-Control', 'no-store');
  return r;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await getServerContext();
  const session = await getAdminSession();
  if (!session) return noStore(NextResponse.redirect(new URL('/signin?next=/connect', ctx.baseUrl), 302));

  const orgId = req.nextUrl.searchParams.get('org');
  const accountId = req.nextUrl.searchParams.get('account') ?? undefined;
  const org = orgId ? await ctx.store.orgClients.get(orgId) : null;
  if (!orgId || !org) return noStore(NextResponse.json({ error: 'Unknown organisation client' }, { status: 404 }));

  let loginHint: string | undefined;
  if (accountId) {
    const acct = (await ctx.store.accounts.list()).find((a) => a.id === accountId);
    if (!acct) return noStore(NextResponse.json({ error: 'Unknown account' }, { status: 404 }));
    loginHint = acct.email;
  }

  const url = await startGoogleAuth({
    store: ctx.store,
    orgClientId: orgId,
    orgClient: org,
    ...(accountId ? { accountId } : {}),
    ...(loginHint ? { loginHint } : {}),
    redirectUri: `${ctx.baseUrl}/api/google/callback`,
    ...(ctx.env.SESSION_SECRET ? { sessionSecret: ctx.env.SESSION_SECRET } : {}),
  });
  return noStore(NextResponse.redirect(url, 302));
}
