import { handleRegister } from '@/oauth/register';
import { getServerContext } from '@/server/context';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleRegister(await getServerContext(), req);
}
