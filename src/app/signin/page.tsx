import { sanitizeNext } from '@/auth/redirect';

export const dynamic = 'force-dynamic';

export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.next) ? sp.next[0] : sp.next;
  const next = sanitizeNext(raw);
  return (
    <main>
      <h1>Sign in</h1>
      <form method="get" action="/api/auth/start">
        <input type="hidden" name="next" value={next} />
        <button type="submit">Sign in with Google</button>
      </form>
    </main>
  );
}
