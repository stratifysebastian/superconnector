// Daily health check (T0.9): exercise each active account's token path so a dead refresh token
// is caught before the morning brief. Output carries labels and kinds only: no emails, tokens
// or error messages.
import type { AccountErrorKind } from '@/core/contracts/account';
import { ProviderError } from '@/core/errors';
import type { ServerContext } from '@/server/context';

export type HealthStatus = 'ok' | 'needs_reconnect' | 'error';

export interface HealthResult {
  label: string;
  status: HealthStatus;
  kind?: AccountErrorKind | 'unknown';
}

export interface HealthSummary {
  checkedAt: string;
  results: HealthResult[];
}

/** Force-refreshes every active account's access token so a dead refresh token is caught daily. */
export async function runHealthCheck(ctx: ServerContext): Promise<HealthSummary> {
  const accounts = await ctx.store.accounts.list();
  const results: HealthResult[] = [];

  for (const account of accounts) {
    if (account.status === 'needs_reconnect') {
      results.push({ label: account.label, status: 'needs_reconnect', kind: 'needs_reconnect' });
      ctx.log.info({
        tool: 'health_check',
        account: account.label,
        outcome: 'needs_reconnect',
        durationMs: 0,
        msg: 'health check skipped',
      });
      continue;
    }
    const started = Date.now();
    let result: HealthResult;
    try {
      await ctx.tokens.getAccessToken(account, { forceRefresh: true });
      result = { label: account.label, status: 'ok' };
    } catch (e) {
      if (e instanceof ProviderError) {
        result = {
          label: account.label,
          status: e.kind === 'needs_reconnect' ? 'needs_reconnect' : 'error',
          kind: e.kind,
        };
        if (e.kind === 'needs_reconnect') await markNeedsReconnect(ctx, account.id);
      } else {
        result = { label: account.label, status: 'error', kind: 'unknown' };
      }
    }
    ctx.log.info({
      tool: 'health_check',
      account: account.label,
      outcome: result.status,
      durationMs: Date.now() - started,
      ...(result.kind ? { kind: result.kind } : {}),
      msg: 'health check account',
    });
    results.push(result);
  }

  const summary: HealthSummary = { checkedAt: new Date().toISOString(), results };
  ctx.log.info({
    tool: 'health_check',
    outcome: results.every((r) => r.status === 'ok') ? 'ok' : 'degraded',
    msg: 'health check summary',
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    needsReconnect: results.filter((r) => r.status === 'needs_reconnect').length,
    errors: results.filter((r) => r.status === 'error').length,
  });
  return summary;
}

/** The token manager normally marks this itself; idempotent backstop. */
async function markNeedsReconnect(ctx: ServerContext, id: string): Promise<void> {
  try {
    await ctx.store.accounts.setStatus(id, 'needs_reconnect');
  } catch {
    // best effort
  }
}

export const CLIENT_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export type CleanupSummary =
  | { codes: number; states: number; tokens: number; clients: number }
  | { error: 'failed' };

export interface MaintenanceSummary extends HealthSummary {
  cleanup: CleanupSummary;
}

/** Health check, then OAuth housekeeping. A cleanup failure never hides the health results. */
export async function runDailyMaintenance(ctx: ServerContext): Promise<MaintenanceSummary> {
  const health = await runHealthCheck(ctx);
  let cleanup: CleanupSummary;
  try {
    const c = await ctx.store.oauth.purgeExpired(Date.now(), CLIENT_MAX_AGE_MS);
    cleanup = { codes: c.codes, states: c.states, tokens: c.tokens, clients: c.clients };
    ctx.log.info({ tool: 'cleanup', outcome: 'ok', msg: 'oauth cleanup', ...cleanup });
  } catch {
    cleanup = { error: 'failed' };
    ctx.log.error({ tool: 'cleanup', outcome: 'error', msg: 'oauth cleanup failed' });
  }
  return { ...health, cleanup };
}
