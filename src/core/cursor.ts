import { createHmac, timingSafeEqual } from 'node:crypto';
import { AccountSelectionError } from './errors';

export type CursorState = Record<string, { pageToken?: string; offset: number }>;

export class InvalidCursorError extends AccountSelectionError {
  constructor() {
    super('The paging cursor is invalid or has been altered. Start the search again without a cursor.', []);
  }
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function encodeCursor(state: CursorState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeCursor(cursor: string, secret: string): CursorState {
  try {
    const parts = cursor.split('.');
    if (parts.length !== 2) throw new Error('shape');
    const [payload, sig] = parts as [string, string];
    const expected = Buffer.from(sign(payload, secret));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new Error('sig');
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('state');
    const out: CursorState = {};
    for (const [label, v] of Object.entries(parsed)) {
      const e = v as { pageToken?: unknown; offset?: unknown } | null;
      if (
        typeof e !== 'object' ||
        e === null ||
        typeof e.offset !== 'number' ||
        !Number.isInteger(e.offset) ||
        e.offset < 0 ||
        (e.pageToken !== undefined && typeof e.pageToken !== 'string')
      ) {
        throw new Error('entry');
      }
      out[label] = e.pageToken === undefined ? { offset: e.offset } : { pageToken: e.pageToken, offset: e.offset };
    }
    return out;
  } catch {
    throw new InvalidCursorError();
  }
}
