import { handleSignout } from '@/auth/signin';
import { getServerContext } from '@/server/context';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleSignout(await getServerContext(), req);
}
