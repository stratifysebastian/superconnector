import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const base64Key32 = z.string().refine(
  (v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32,
  { message: 'must be base64 that decodes to exactly 32 bytes' },
);
const secret32 = z.string().min(32, { message: 'must be at least 32 characters' });
const httpsOrigin = z.string().refine(
  (v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && v === u.origin;
    } catch {
      return false;
    }
  },
  { message: 'must be an https origin with no path, query or trailing slash' },
);
const nonEmpty = z.string().min(1, { message: 'is required' });

const emailList = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  )
  .refine((a) => a.length > 0, { message: 'must list at least one email' });

export type Env = {
  GOOGLE_MODE: 'mock' | 'live';
  STORE: 'memory' | 'supabase';
  ENCRYPTION_KEY?: string;
  SESSION_SECRET?: string;
  CURSOR_SECRET?: string;
  ADMIN_EMAILS: string[];
  ADMIN_GOOGLE_CLIENT_ID?: string;
  ADMIN_GOOGLE_CLIENT_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  PUBLIC_BASE_URL?: string;
  CRON_SECRET?: string;
};

const mode = z.enum(['mock', 'live']);
const store = z.enum(['memory', 'supabase']);

/** Treat empty strings (e.g. from a blank .env line) as unset. */
function raw(source: Record<string, string | undefined>, key: string): string | undefined {
  const v = source[key];
  return v === undefined || v === '' ? undefined : v;
}

function buildSchema(live: boolean) {
  const req = <T extends z.ZodTypeAny>(s: T) => (live ? s : s.optional());
  return z.object({
    GOOGLE_MODE: mode,
    STORE: live ? z.literal('supabase', { message: 'must be supabase in live mode' }) : store,
    ENCRYPTION_KEY: req(base64Key32),
    SESSION_SECRET: req(secret32),
    CURSOR_SECRET: req(secret32),
    ADMIN_EMAILS: live ? emailList : emailList.optional().transform((v) => v ?? []),
    ADMIN_GOOGLE_CLIENT_ID: req(nonEmpty),
    ADMIN_GOOGLE_CLIENT_SECRET: req(nonEmpty),
    SUPABASE_URL: req(z.string().url()),
    SUPABASE_SERVICE_ROLE_KEY: req(nonEmpty),
    PUBLIC_BASE_URL: live ? httpsOrigin : z.string().url().optional(),
    CRON_SECRET: live ? secret32 : nonEmpty.optional(),
  });
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const rawMode = raw(source, 'GOOGLE_MODE');
  const deployed = raw(source, 'VERCEL_ENV') !== undefined || raw(source, 'NODE_ENV') === 'production';
  // Fail closed: a deployed or production-built process must choose its mode explicitly.
  if (rawMode === undefined && deployed) {
    throw new Error('Invalid environment: GOOGLE_MODE must be set explicitly when VERCEL_ENV is set or NODE_ENV is production');
  }
  const modeResult = mode.safeParse(rawMode ?? 'mock');
  if (!modeResult.success) {
    throw new Error('Invalid environment: GOOGLE_MODE must be "mock" or "live"');
  }
  const googleMode = modeResult.data;
  if (googleMode === 'mock' && raw(source, 'VERCEL_ENV') === 'production') {
    throw new Error('Invalid environment: GOOGLE_MODE=mock is not allowed when VERCEL_ENV is production');
  }
  const live = googleMode === 'live';
  const keys = [
    'ENCRYPTION_KEY',
    'SESSION_SECRET',
    'CURSOR_SECRET',
    'ADMIN_EMAILS',
    'ADMIN_GOOGLE_CLIENT_ID',
    'ADMIN_GOOGLE_CLIENT_SECRET',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'PUBLIC_BASE_URL',
    'CRON_SECRET',
  ];
  const input: Record<string, string | undefined> = {
    GOOGLE_MODE: googleMode,
    STORE: raw(source, 'STORE') ?? (live ? 'supabase' : 'memory'),
  };
  for (const k of keys) input[k] = raw(source, k);
  // Supabase's newer API keys name the server key SUPABASE_SECRET_KEY (sb_secret_...); the Vercel
  // Supabase integration sets that name. Accept it when the legacy service-role name is absent.
  input.SUPABASE_SERVICE_ROLE_KEY ??= raw(source, 'SUPABASE_SECRET_KEY');

  const result = buildSchema(live).safeParse(input);
  if (!result.success) {
    // Messages name the variable and the rule only; values are never included.
    const problems = result.error.issues.map((i) => `${String(i.path[0] ?? 'env')}: ${i.message}`);
    throw new Error(`Invalid environment (GOOGLE_MODE=${googleMode}): ${problems.join('; ')}`);
  }
  return result.data as Env;
}

let cached: Env | undefined;

/** Lazy: reads process.env on first call, never at import time. */
export function getEnv(): Env {
  cached ??= withMockSecrets(parseEnv(process.env));
  return cached;
}

/**
 * Mock mode may run without secrets. Instead of a constant (which would be public in the repo),
 * fill the gaps with random per-call values. Live mode never gets here with a gap.
 */
export function withMockSecrets(env: Env): Env {
  if (env.GOOGLE_MODE !== 'mock') return env;
  return {
    ...env,
    SESSION_SECRET: env.SESSION_SECRET ?? randomBytes(32).toString('base64url'),
    CURSOR_SECRET: env.CURSOR_SECRET ?? randomBytes(32).toString('base64url'),
  };
}

/** For tests. */
export function resetEnvCache(): void {
  cached = undefined;
}
