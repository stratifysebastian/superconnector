import { handleSigninCallback } from '@/auth/signin';
import { getServerContext } from '@/server/context';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleSigninCallback(await getServerContext(), req);
}
