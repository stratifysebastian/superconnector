import type { z } from 'zod';
import type { Account } from './account';
import type { Provider } from './account';
import type { AdapterContext, AdapterFactory, QuickBooksAdapterContext } from './adapter';
import type { FanOutEngine } from './fanout';
import type { Store } from './store';

export interface ToolDef<I extends z.ZodTypeAny> {
  name: string; // mirrors the built-in connector's name exactly
  description: string; // built-in description + account notes
  input: I; // built-in input schema + optional `account`
  kind: 'read' | 'lookup' | 'write';
  /**
   * Which provider's accounts this tool may see. Default 'google'. 'any' is only for list_accounts.
   * The registry hands the handler a ToolContext whose store and fanout are already limited to this provider.
   */
  provider?: Provider | 'any';
  handler(input: z.infer<I>, ctx: ToolContext): Promise<unknown>;
}
export interface ToolContext {
  store: Store;
  fanout: FanOutEngine;
  adapters: AdapterFactory;
  /** Builds the per-account context (guarded GoogleHttp bound to that account's token). */
  adapterContext(account: Account, signal?: AbortSignal): AdapterContext;
  /** Builds the per-company context (guarded IntuitHttp bound to that company's token and realmId). */
  quickbooksContext(account: Account, signal?: AbortSignal): QuickBooksAdapterContext;
  log: Logger;
}
export interface Logger {
  info(e: LogEvent): void;
  warn(e: LogEvent): void;
  error(e: LogEvent): void;
}
export interface LogEvent {
  tool?: string;
  account?: string;
  durationMs?: number;
  outcome?: string;
  msg: string;
  [k: string]: unknown;
}
