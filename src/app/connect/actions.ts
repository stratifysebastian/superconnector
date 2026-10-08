'use server';
// Server actions taking plain inputs. Each re-checks the admin session.
import { revalidatePath } from 'next/cache';
import { getAdminSession } from '@/auth/session';
import { getServerContext, type ServerContext } from '@/server/context';
import * as logic from './logic';
import type { OrgClientInput, Result, RevokeResult } from './logic';

async function run(fn: (ctx: ServerContext, s: logic.Session | null) => Promise<Result>): Promise<Result> {
  const session = await getAdminSession();
  if (!session) return { ok: false, error: 'Unauthorised: sign in again.' };
  const result = await fn(await getServerContext(), session);
  if (result.ok) revalidatePath('/connect');
  return result;
}

export async function reorderAccounts(input: { accountId: string; direction: 'up' | 'down' }): Promise<Result> {
  return run((ctx, s) => logic.reorderAccounts(ctx, s, input));
}

export async function renameAccount(input: { accountId: string; label: string }): Promise<Result> {
  return run((ctx, s) => logic.renameAccount(ctx, s, input));
}

export async function saveOrgClient(input: OrgClientInput): Promise<Result> {
  return run((ctx, s) => logic.saveOrgClient(ctx, s, input));
}

export async function revokeAllAccess(input: { confirmed: boolean }): Promise<RevokeResult> {
  const session = await getAdminSession();
  if (!session) return { ok: false, error: 'Unauthorised: sign in again.' };
  const result = await logic.revokeAllAccess(await getServerContext(), session, input);
  if (result.ok) revalidatePath('/connect');
  return result;
}
