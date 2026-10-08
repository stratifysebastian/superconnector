import { timingSafeEqualStr } from '@/lib/crypto';
import type { ServerContext } from '@/server/context';
import { runDailyMaintenance } from './health';

/** Never runs unauthenticated: unset secret -> 503, missing/wrong bearer -> 401 with no detail. */
export async function handleHealthRequest(req: Request, ctx: ServerContext): Promise<Response> {
  const secret = ctx.env.CRON_SECRET;
  if (!secret) return Response.json({ error: 'not configured' }, { status: 503 });
  const header = req.headers.get('authorization') ?? '';
  if (!timingSafeEqualStr(header, `Bearer ${secret}`)) return new Response(null, { status: 401 });
  const summary = await runDailyMaintenance(ctx);
  return Response.json(summary, { headers: { 'cache-control': 'no-store' } });
}
