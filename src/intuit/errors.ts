import { GuardrailError, ProviderError } from '@/core/errors';
import type { AccountErrorKind } from '@/core/contracts/account';

/** A failed QuickBooks call. Carries only what Intuit's support asks for: status, error code/name and intuit_tid. */
export class IntuitError extends ProviderError {
  constructor(
    kind: AccountErrorKind,
    message: string,
    status?: number,
    readonly intuitCode?: string,
    readonly intuitName?: string,
    readonly tid?: string,
  ) {
    super(kind, message, status);
  }
}

export interface IntuitFault {
  code?: string;
  /** Intuit's short error name, e.g. "Duplicate Name Exists Error". Never the Detail text, which can hold names. */
  name?: string;
  type?: string;
}

/** Intuit error titles that are safe to show and log. Anything else is reduced to "Intuit error" plus the code. */
const KNOWN_TITLES = new Set([
  'Duplicate Name Exists Error', 'Object Not Found', 'Invalid Reference Id', 'Required param missing, need to supply the required value for the API',
  'Business Validation Error', 'Request has invalid or unsupported property', 'Invalid Number', 'Invalid Date', 'AuthenticationFailed',
  'AuthorizationFailed', 'ApplicationAuthorizationFailed', 'ValidationFault', 'Stale Object Error', 'Unsupported Operation', 'Feature Not Supported',
  'Permission Denied Error',
]);

/** Reads Fault.Error[0] from an error body. Only the code, the short name and the fault type survive. */
export function parseFault(body: unknown): IntuitFault {
  const fault = (body as { Fault?: { type?: unknown; Error?: { code?: unknown; Message?: unknown }[] } } | null)?.Fault;
  const e = Array.isArray(fault?.Error) ? fault.Error[0] : undefined;
  const code = typeof e?.code === 'string' && /^\d{1,8}$/.test(e.code) ? e.code : undefined;
  // Message is Intuit's fixed error title, sometimes wrapped as "message=Title; errorCode=...". Only known titles pass; free text may hold names.
  const title = typeof e?.Message === 'string' ? e.Message.replace(/^message=/, '').split(';')[0]!.trim() : undefined;
  const name = title === undefined ? undefined : KNOWN_TITLES.has(title) ? title : `Intuit error${code ? ` ${code}` : ''}`;
  const type = typeof fault?.type === 'string' && /^[A-Za-z]{1,40}$/.test(fault.type) ? fault.type : undefined;
  return { ...(code ? { code } : {}), ...(name ? { name } : {}), ...(type ? { type } : {}) };
}

const FEATURE_CODES = new Set(['120', '130', '5020']);
const FEATURE_WORDS = /not (?:supported|available|enabled|allowed|authorized)|permission|subscription|upgrade|feature|authoriz/i;

/** A missing plan feature or permission, judged from the code, fault type and error name (never from Detail text). */
export const isFeatureOrPermissionFault = (f: IntuitFault): boolean =>
  (f.code !== undefined && FEATURE_CODES.has(f.code)) || f.type === 'AuthorizationFault' || (f.name !== undefined && FEATURE_WORDS.test(f.name));

/** The plain-language message for a rejected request (400 and other 4xx with or without a Fault). */
export function faultMessage(label: string, status: number, f: IntuitFault): string {
  const what = f.name ?? 'the request was not accepted';
  const code = f.code ? ` (error code ${f.code})` : ` (HTTP ${status})`;
  const plan = isFeatureOrPermissionFault(f) ? ' This may not be available on your QuickBooks plan.' : '';
  return `QuickBooks could not ${label}: ${what}${code}.${plan}`;
}

/** Short code for audit_log.detail: status, Intuit code and name, intuit_tid. At most 200 characters; no names or amounts. */
export function failureDetail(e: unknown): string {
  let d: string;
  if (e instanceof IntuitError) {
    d = [e.status ? `http ${e.status}` : e.kind, e.intuitCode && `code ${e.intuitCode}`, e.intuitName, e.tid && `tid ${e.tid}`].filter(Boolean).join('; ');
  } else if (e instanceof ProviderError) {
    d = [e.status ? `http ${e.status}` : undefined, e.kind].filter(Boolean).join('; ');
  } else if (e instanceof GuardrailError) {
    d = `blocked ${e.rule}`;
  } else {
    d = e instanceof Error ? e.name : 'error';
  }
  return d.slice(0, 200);
}
