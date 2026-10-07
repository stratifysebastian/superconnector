import { handleToken } from '@/oauth/token';
import { getServerContext } from '@/server/context';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleToken(await getServerContext(), req);
}
