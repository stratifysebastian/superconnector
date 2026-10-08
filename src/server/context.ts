// Composition root (orchestrator-owned). Builds the per-process services every route uses.
import { randomBytes } from 'node:crypto';
import type { AdapterFactory } from '@/core/contracts/adapter';
import type { Cipher } from '@/core/contracts/crypto';
import type { FanOutEngine } from '@/core/contracts/fanout';
import type { Store } from '@/core/contracts/store';
import type { Logger } from '@/core/contracts/tool';
import { createFanOutEngine } from '@/core/fanout';
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
}

const MOCK_BASE_URL = 'http://localhost:3000';

function requireSecret(v: string | undefined): string {
  if (!v) throw new Error('CURSOR_SECRET is required');
  return v;
}

function notYet(product: string): never {
  throw new Error(`${product} tools are not available yet`);
}

export interface CreateServerContextOptions {
  env?: Env;
  store?: Store;
  log?: Logger;
  tokens?: TokenManager;
  /** Seed the two mock accounts into a memory store (default: true in mock mode with STORE=memory). */
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
  if (opts.seedMock ?? (mock && env.STORE === 'memory')) await seedMockAccounts(store);

  const tokens: TokenManager =
    opts.tokens ??
    (mock ? { getAccessToken: async (a) => mockAccessToken(a.label) } : createTokenManager({ store, log }));

  const fanout = createFanOutEngine({
    listAccounts: () => store.accounts.list(),
    cursorSecret: requireSecret(env.CURSOR_SECRET),
    reconnectUrl: `${baseUrl}/connect`,
  });

  // Product adapters arrive phase by phase (Phase 1: calendar).
  const adapters: AdapterFactory = { calendar: () => notYet('Calendar') };

  return { env, baseUrl, cipher, store, log, fanout, tokens, adapters };
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
