import { handleSigninStart } from '@/auth/signin';
import { getServerContext } from '@/server/context';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleSigninStart(await getServerContext(), req);
}
