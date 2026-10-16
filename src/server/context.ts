// Composition root (orchestrator-owned). Builds the per-process services every route uses.
import { randomBytes } from 'node:crypto';
import type { Account } from '@/core/contracts/account';
import type { AdapterContext, AdapterFactory, QuickBooksAdapterContext } from '@/core/contracts/adapter';
import type { Cipher } from '@/core/contracts/crypto';
import type { FanOutEngine } from '@/core/contracts/fanout';
import type { Store } from '@/core/contracts/store';
import type { Logger } from '@/core/contracts/tool';
import { createFanOutEngine } from '@/core/fanout';
import { createLiveCalendarAdapter } from '@/google/calendar';
import { createLiveDriveAdapter } from '@/google/drive';
import { createLiveGmailAdapter } from '@/google/gmail';
import { createGoogleHttp } from '@/google/http';
import { createIntuitHttp } from '@/intuit/http';
import { seedMockIntuit } from '@/intuit/mock/seed';
import { createMockQuickBooksAdapter } from '@/intuit/mock/quickbooks';
import { createLiveQuickBooksAdapter } from '@/intuit/quickbooks';
import { createIntuitTokenManager } from '@/intuit/token-manager';
import { createMockCalendarAdapter } from '@/google/mock/calendar';
import { createMockDriveAdapter } from '@/google/mock/drive';
import { createMockGmailAdapter } from '@/google/mock/gmail';
import { mockAccessToken } from '@/google/mock/token';
import { seedMockAccounts } from '@/google/mock/seed';
import { createTokenManager, type TokenManager } from '@/google/token-manager';
import { createCipher } from '@/lib/crypto';
import { getEnv, withMockSecrets, type Env } from '@/lib/env';
import { createLogger } from '@/lib/log';
import { getStore } from '@/store';

export interface ServerContext {
  env: Env;
  baseUrl: string;
  cipher: Cipher;
  store: Store;
  log: Logger;
  fanout: FanOutEngine;
  tokens: TokenManager;
  adapters: AdapterFactory;
  adapterContext(account: Account, signal?: AbortSignal): AdapterContext;
  quickbooksContext(account: Account, signal?: AbortSignal): QuickBooksAdapterContext;
}

const MOCK_BASE_URL = 'http://localhost:3000';

function requireSecret(v: string | undefined): string {
  if (!v) throw new Error('CURSOR_SECRET is required');
  return v;
}

export interface CreateServerContextOptions {
  env?: Env;
  store?: Store;
  log?: Logger;
  tokens?: TokenManager;
  /** Seed the mock accounts (two Google, one QuickBooks) into a memory store (default: true in mock mode with STORE=memory). */
  seedMock?: boolean;
}

export async function createServerContext(opts: CreateServerContextOptions = {}): Promise<ServerContext> {
  // Mock mode without secrets gets fresh random ones for this context; nothing constant is ever used.
  const env = withMockSecrets(opts.env ?? getEnv());
  const mock = env.GOOGLE_MODE === 'mock';
  // Live mode env validation guarantees PUBLIC_BASE_URL and CURSOR_SECRET.
  const baseUrl = env.PUBLIC_BASE_URL ?? MOCK_BASE_URL;
  // Mock mode may run without ENCRYPTION_KEY: use a throwaway per-process key (memory store only).
  const key = env.ENCRYPTION_KEY ?? (mock ? randomBytes(32).toString('base64') : undefined);
  if (!key) throw new Error('ENCRYPTION_KEY is required');
  const cipher = createCipher(key);
  const store = opts.store ?? getStore(() => cipher);
  const log = opts.log ?? createLogger();
  if (opts.seedMock ?? (mock && env.STORE === 'memory')) {
    await seedMockAccounts(store);
    await seedMockIntuit(store);
  }

  // One token manager per provider behind one entry point: an account is only ever refreshed by its own provider's code.
  const google = createTokenManager({ store, log });
  const intuit = createIntuitTokenManager({ store, log });
  const tokens: TokenManager =
    opts.tokens ??
    (mock
      ? { getAccessToken: async (a) => mockAccessToken(a.label) }
      : { getAccessToken: (a, o) => (a.provider === 'intuit' ? intuit : google).getAccessToken(a, o) });

  const fanout = createFanOutEngine({
    listAccounts: () => store.accounts.list(),
    cursorSecret: requireSecret(env.CURSOR_SECRET),
    reconnectUrl: `${baseUrl}/connect`,
  });

  // Product adapters arrive phase by phase. Mock mode never touches Google.
  const adapters: AdapterFactory = {
    calendar: mock ? createMockCalendarAdapter : createLiveCalendarAdapter,
    gmail: mock ? createMockGmailAdapter : createLiveGmailAdapter,
    drive: mock ? createMockDriveAdapter : createLiveDriveAdapter,
    quickbooks: mock ? createMockQuickBooksAdapter : createLiveQuickBooksAdapter,
  };

  const adapterContext = (account: Account, signal: AbortSignal = new AbortController().signal): AdapterContext => {
    if (account.provider !== 'google') throw new Error('Not a Google account');
    return {
      account,
      signal,
      http: createGoogleHttp({ getAccessToken: () => tokens.getAccessToken(account), signal, log, selfEmail: account.email }),
    };
  };

  const quickbooksContext = (account: Account, signal: AbortSignal = new AbortController().signal): QuickBooksAdapterContext => {
    if (account.provider !== 'intuit' || !account.realmId) throw new Error('Not a QuickBooks company');
    return {
      account,
      signal,
      http: createIntuitHttp({
        getAccessToken: (force) => tokens.getAccessToken(account, force ? { forceRefresh: true } : undefined),
        realmId: account.realmId,
        env: env.INTUIT_ENV,
        signal,
        log,
      }),
    };
  };

  return { env, baseUrl, cipher, store, log, fanout, tokens, adapters, adapterContext, quickbooksContext };
}

let cached: Promise<ServerContext> | undefined;

/** Lazy per-process singleton for route handlers. */
export function getServerContext(): Promise<ServerContext> {
  cached ??= createServerContext();
  return cached;
}

/** For tests. */
export function resetServerContext(): void {
  cached = undefined;
}
