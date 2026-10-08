import { isAdminEmail } from '@/auth/allowlist';
import { hashToken } from '@/lib/crypto';
import { getServerContext, type ServerContext } from '@/server/context';

export interface BearerIdentity {
  subject: string; // admin email the token was issued to
  clientId: string; // DCR client id
}

/** Context-explicit core of verifyBearer (testable without Next.js). */
export async function verifyBearerWithContext(ctx: ServerContext, req: Request): Promise<BearerIdentity | null> {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const m = /^bearer[ \t]+([^\s]+)$/i.exec(header.trim());
  const token = m?.[1];
  if (!token || token.length > 512) return null;
  try {
    const row = await ctx.store.oauth.findToken(hashToken(token));
    if (!row || row.kind !== 'access' || row.revoked || row.expiresAt <= Date.now()) return null;
    if (!isAdminEmail(ctx.env, row.subject)) return null;
    return { subject: row.subject.toLowerCase(), clientId: row.clientId };
  } catch {
    return null;
  }
}

/** Verifies `Authorization: Bearer <access token>` against the store. Null when missing, unknown, expired or revoked. */
export async function verifyBearer(req: Request): Promise<BearerIdentity | null> {
  return verifyBearerWithContext(await getServerContext(), req);
}
