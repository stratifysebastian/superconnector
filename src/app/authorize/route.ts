import { handleAuthorizeGet, handleAuthorizePost } from '@/oauth/authorize';
import { getServerContext } from '@/server/context';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleAuthorizeGet(await getServerContext(), req);
}

export async function POST(req: Request): Promise<Response> {
  return handleAuthorizePost(await getServerContext(), req);
}
