import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Account } from '@/core/contracts/account';
import { ProviderError } from '@/core/errors';

export type MockFault = 'invalid_grant' | 'rate_limited' | 'timeout';
type FaultMap = Record<string, MockFault | undefined>;

let faults: FaultMap | undefined;

function defaults(): FaultMap {
  const file = path.join(process.cwd(), 'fixtures', 'faults.json');
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')) as FaultMap;
}

export function setMockFaults(map: Record<string, MockFault | undefined>): void {
  faults = { ...map };
}

export function getMockFault(label: string): MockFault | undefined {
  faults ??= defaults();
  return faults[label];
}

/** Back to the defaults from fixtures/faults.json. */
export function resetMockFaults(): void {
  faults = undefined;
}

export interface MockFaultOptions {
  /** 'hang' (default): never resolves until `signal` aborts. 'throw': reject with a timeout at once. */
  timeoutBehaviour?: 'hang' | 'throw';
  signal?: AbortSignal;
}

/** Runs `fn` unless a fault is injected for the account. */
export async function withMockFaults<T>(
  account: string | Pick<Account, 'label'>,
  fn: () => Promise<T> | T,
  opts: MockFaultOptions = {},
): Promise<T> {
  const label = typeof account === 'string' ? account : account.label;
  const fault = getMockFault(label);
  if (fault === 'invalid_grant') {
    throw new ProviderError('needs_reconnect', 'Google account needs to be reconnected');
  }
  if (fault === 'rate_limited') {
    throw new ProviderError('rate_limited', 'Google rate limit exceeded after retries', 429);
  }
  if (fault === 'timeout') {
    if (opts.timeoutBehaviour === 'throw') throw new ProviderError('timeout', 'Google request timed out');
    return new Promise<T>((_resolve, reject) => {
      const { signal } = opts;
      if (!signal) return; // never settles
      const abort = () => reject(new ProviderError('timeout', 'Google request timed out'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }
  return fn();
}
