import { protectedResourceMetadata } from '@/oauth/metadata';
import { getServerContext } from '@/server/context';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return protectedResourceMetadata(await getServerContext());
}
