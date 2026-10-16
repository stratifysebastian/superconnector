import { redirect } from 'next/navigation';
import { getAdminSession } from '@/auth/session';
import { ConnectView } from '@/components/ConnectView';
import { getServerContext } from '@/server/context';
import { loadConnectData, parseFlash } from './logic';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Connect accounts · Superconnector' };

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getAdminSession();
  if (!session) redirect('/signin?next=/connect');
  const ctx = await getServerContext();
  const [data, params] = await Promise.all([loadConnectData(ctx, session), searchParams]);
  return <ConnectView data={data} flash={parseFlash(params)} />;
}
