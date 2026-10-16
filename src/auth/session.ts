import { cookies } from 'next/headers';
import { getEnv, type Env } from '@/lib/env';
import { getServerContext } from '@/server/context';
import { parseCookies } from './cookies';
import { SESSION_COOKIE, verifySessionToken } from './session-token';

export interface AdminSession {
  email: string; // lowercase, on the ADMIN_EMAILS allowlist
  expiresAt: number; // ms epoch
}

/** Reads and verifies the admin session cookie. Null when absent, invalid or expired. */
export async function getAdminSession(): Promise<AdminSession | null> {
  try {
    const jar = await cookies();
    return await verifySessionToken(jar.get(SESSION_COOKIE)?.value, (await getServerContext()).env);
  } catch {
    return null;
  }
}

/** Same check for route handlers and tests, from a plain Request. */
export async function getAdminSessionFromRequest(req: Request, env: Env = getEnv()): Promise<AdminSession | null> {
  try {
    return await verifySessionToken(parseCookies(req.headers.get('cookie')).get(SESSION_COOKIE), env);
  } catch {
    return null;
  }
}
