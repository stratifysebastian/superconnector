import { createClient } from '@supabase/supabase-js';
import type { Cipher } from '../core/contracts/crypto';
import type { Store } from '../core/contracts/store';
import { getEnv } from '../lib/env';
import { createMemoryStore } from './memory';
import { createSupabaseStore } from './supabase';

let instance: Store | undefined;

/** Lazy singleton. The cipher factory is only called the first time. */
export function getStore(cipherFactory: () => Cipher): Store {
  if (instance) return instance;
  const env = getEnv();
  if (env.STORE === 'supabase') {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('STORE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    }
    const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    instance = createSupabaseStore(client, cipherFactory());
  } else {
    instance = createMemoryStore(cipherFactory());
  }
  return instance;
}

/** For tests. */
export function resetStore(): void {
  instance = undefined;
}
