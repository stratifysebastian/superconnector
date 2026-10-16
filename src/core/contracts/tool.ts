import type { z } from 'zod';
import type { AdapterFactory } from './adapter';
import type { FanOutEngine } from './fanout';
import type { Store } from './store';

export interface ToolDef<I extends z.ZodTypeAny> {
  name: string; // mirrors the built-in connector's name exactly
  description: string; // built-in description + account notes
  input: I; // built-in input schema + optional `account`
  kind: 'read' | 'lookup' | 'write';
  handler(input: z.infer<I>, ctx: ToolContext): Promise<unknown>;
}
export interface ToolContext {
  store: Store;
  fanout: FanOutEngine;
  adapters: AdapterFactory;
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
