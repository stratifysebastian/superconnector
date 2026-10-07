import { handleHealthRequest } from '@/cron/handler';
import { getServerContext } from '@/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  return handleHealthRequest(req, await getServerContext());
}
