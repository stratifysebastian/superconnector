import type { Env } from '@/lib/env';

/** True when the (case-insensitive) email is on the current ADMIN_EMAILS allowlist. */
export function isAdminEmail(env: Pick<Env, 'ADMIN_EMAILS'>, email: unknown): email is string {
  if (typeof email !== 'string' || email.length === 0) return false;
  return env.ADMIN_EMAILS.includes(email.trim().toLowerCase());
}
