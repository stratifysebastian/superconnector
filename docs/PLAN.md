# Build Plan — Multi-Account Google Connector

Source of truth: `docs/SPEC.md`. If this plan conflicts with the spec, the spec wins.

Status legend: ⬜ not started · 🟦 in progress · ✅ done (merged, tests green) · ⛔ blocked

| Phase | Status |
| --- | --- |
| 0 Foundation | 🟦 plan approved 2026-10-07; building |
| 1 Calendar | ⬜ |
| 2 Gmail | ⬜ |
| 3 Drive | ⬜ |
| 4 Docs | ⬜ |
| 5 Sheets | ⬜ |
| 6 Slides | ⬜ |
| 7 Microsoft 365 | out of scope until a separate spec round |

Repo: `stratifysebastian/superconnector` (confirmed by Seb, 2026-10-07).

---

## 1. Working model

- **Orchestrator (Opus)** plans, writes this file, reviews every diff, merges and runs the full suite after each merge. It does not grade its own audits.
- **Implementers (Sonnet subagents)** each take one task below in its own git worktree. Each gets the quoted spec sections, the interfaces in §3, its file list, its tests and the hard rules in §6.
- **Auditors (fresh Sonnet subagents)** never saw the code being written. They audit (a) the guardrails and the excluded-endpoint contract test and (b) the OAuth and token-security code. Findings go back to an implementer, not the auditor.
- **Review gate per task:** the `engineering:code-review` checklist plus the built-in `/code-review`. Fail means bounce back with specific fixes. Pass means merge, then `npm run check` (lint, typecheck, full test suite).
- **Mock first:** every phase runs with `GOOGLE_MODE=mock` until its mock tests pass. No live Google call before that.
- **File ownership is exclusive.** A task edits only the files it owns. `package.json`, lockfile, `tsconfig.json` and everything under `src/core/contracts/` belong to T0.0 and the orchestrator. Subagents that need a dependency or a contract change say so in their report; they do not make the change.

## 2. Architecture decisions (ADRs, short form)

| # | Decision | Chosen | Why / trade-off |
| --- | --- | --- | --- |
| ADR-1 | Language and runtime | TypeScript (strict), Next.js App Router route handlers, Node runtime (not Edge), Node 22 | Spec locks Next.js on Vercel. Node runtime is needed for `crypto` AES-GCM and the MCP SDK. |
| ADR-2 | MCP transport | Official `@modelcontextprotocol/sdk`, Streamable HTTP, **stateless** (new server and transport per request, no session id) | Vercel functions are stateless; nothing on the server needs a session. The T0.7 implementer confirms the exact web-standard transport class in the installed SDK version before use. |
| ADR-3 | Google API client | Thin typed `fetch` wrappers per product, **not** `googleapis` | Small bundle, easy to mock, and every URL is a literal string, so the contract test can scan for excluded endpoints reliably. |
| ADR-4 | Secret encryption | App-layer AES-256-GCM, key in `ENCRYPTION_KEY` (32 bytes, base64), ciphertext prefixed with a key version (`v1:`) for rotation | Testable in mock mode with no Supabase; Vault stays an option later. Spec allows either. |
| ADR-5 | Data access | `Store` interface with two implementations: in-memory (tests and mock mode) and Supabase (service role, server only). RLS enabled on every table with **no** policies, so `anon` and `authenticated` see nothing. | Defense in depth: the service role bypasses RLS and is the only thing that ever connects. |
| ADR-6 | Admin sign-in (gates `/authorize` and `/connect`) | Google OIDC sign-in using a **bootstrap sign-in client** from Vercel env (`ADMIN_GOOGLE_CLIENT_ID/SECRET`, scopes `openid email` only), with an email allowlist `ADMIN_EMAILS`. Session is an HS256 JWT in an `HttpOnly; Secure; SameSite=Lax` cookie (`SESSION_SECRET`), 12 h. | Bootstrap problem: org clients are entered through `/connect`, which already needs a sign-in. The sign-in client can be the Stratify org's OAuth client (Internal is fine because Seb signs in with his Stratify identity); the allowlist can still list his PR1ME identity for when that client is used. |
| ADR-7 | OAuth 2.1 server for Claude | Self-built, minimal: RFC 8414 metadata, RFC 9728 protected-resource metadata, RFC 7591 DCR, auth code + **PKCE S256 only**, no implicit, no password grant. Access tokens are opaque, 1 h; refresh tokens are opaque, 30 days, rotated on use with reuse detection. Only SHA-256 hashes are stored. Redirect URIs must match exactly. | No third-party auth service to trust or pay for, and the surface is small. Reviewed by a fresh auditor. |
| ADR-8 | Tables beyond the spec's data model | Adds `oauth_clients`, `oauth_codes`, `oauth_tokens` (hashed) and `oauth_state` (Google connect CSRF state, short TTL) | The OAuth 2.1 server needs storage the spec doesn't list. **Flagged as a deviation (addition).** |
| ADR-9 | Tests | Vitest. MCP tests use the SDK `Client` against the route handler in-process. No network in CI. | Fast and deterministic. |
| ADR-10 | Account labels | `accounts.label` defaults to the org client's label (`stratify`, `prime`); unique; `-2`, `-3` suffix if a second account joins the same org. Editable on `/connect`. | Spec examples use org-style labels. |

## 3. Interfaces (written first by T0.0, frozen after review)

All of these live in `src/core/contracts/`. Changing them later needs the orchestrator.

```ts
// src/core/contracts/account.ts
export type Provider = 'google' | 'microsoft';
export type AccountStatus = 'active' | 'needs_reconnect';
export type Product = 'calendar' | 'gmail' | 'drive' | 'docs' | 'sheets' | 'slides';

export interface Account {
  id: string;               // uuid
  provider: Provider;
  email: string;
  label: string;            // 'stratify', 'prime'
  orgClientId: string;
  priority: number;         // lower = earlier; Stratify = 0
  connectedAt: string;      // ISO
  status: AccountStatus;
  grantedScopes: string[];
}

/** Tool argument: label, email, list of either, or 'all'. Omitted = 'all' for reads. */
export type AccountSelector = string | string[] | 'all' | undefined;

export type AccountErrorKind =
  | 'needs_reconnect'      // invalid_grant
  | 'missing_scope'
  | 'rate_limited'         // 429 after retries
  | 'timeout'
  | 'not_found'
  | 'upstream_error';

export interface AccountError {
  account: string;         // label
  accountEmail: string;
  kind: AccountErrorKind;
  message: string;         // plain language, e.g. "PR1ME account disconnected — reconnect at /connect"
  action?: string;         // e.g. reconnect URL
}

/** Every item returned from a fan-out read. */
export type Tagged<T> = T & { account: string; accountEmail: string };
/** De-duplicated items (calendar events, drive files) also carry this. */
export interface MultiSource {
  accounts: string[];                                   // labels, priority order
  sources: { account: string; id: string; calendarId?: string }[];
}
```

```ts
// src/core/contracts/fanout.ts
import type { Account, AccountError, AccountSelector, Tagged, MultiSource } from './account';

export interface PageRequest { pageSize: number; cursor?: string }
export interface AccountPage<T> { items: T[]; nextPageToken?: string }

export interface FanOutReadSpec<T> {
  selector: AccountSelector;
  page: PageRequest;
  /** Calls one account's adapter. Receives that account's own page token. */
  fetch: (account: Account, pageToken: string | undefined, pageSize: number) => Promise<AccountPage<T>>;
  /** Natural date of an item (ms epoch): message date, event start, modifiedTime. */
  dateOf: (item: T) => number;
  /** Optional de-dup key: `${iCalUID}|${start}` for events, file id for Drive. */
  dedupeKey?: (item: T) => string | undefined;
  /** Per-item native id, kept in `sources` when items collapse. */
  idOf?: (item: T) => { id: string; calendarId?: string };
  timeoutMs?: number;      // default 15000
}

export interface FanOutReadResult<T> {
  items: Array<Tagged<T> & Partial<MultiSource>>;   // newest first; ties by account priority
  nextCursor?: string;                              // opaque; encodes each account's page token
  accountErrors: AccountError[];                    // never omitted; [] when clean
}

export interface FanOutEngine {
  read<T>(spec: FanOutReadSpec<T>): Promise<FanOutReadResult<T>>;
  /** Lookup by id: tries accounts in priority order and returns the first hit. */
  lookup<T>(selector: AccountSelector, fn: (a: Account) => Promise<T | null>):
    Promise<{ item: Tagged<T> | null; accountErrors: AccountError[] }>;
  /** Writes: exactly one account, or an error asking which one. Never fans out. */
  resolveWriteAccount(selector: AccountSelector, fallback?: () => Promise<Account | null>): Promise<Account>;
}
```

```ts
// src/core/contracts/adapter.ts
import type { Account } from './account';

/** Everything an adapter needs to make one call for one account. */
export interface AdapterContext {
  account: Account;
  /** Returns a fresh access token. Throws GoogleAuthError('invalid_grant') → account marked needs_reconnect. */
  getAccessToken(): Promise<string>;
  /** fetch wrapper: auth header, 429 backoff with jitter (max 3 retries), timeout, structured log. */
  http: GoogleHttp;
  signal: AbortSignal;
}

export interface GoogleHttp {
  json<T>(req: { method: 'GET' | 'POST' | 'PATCH' | 'PUT'; url: string; query?: Record<string, string | number | boolean | undefined>; body?: unknown }): Promise<T>;
}
// Note: no 'DELETE' method exists on GoogleHttp. No adapter can issue one.

/** Each product adds its own interface in its phase, e.g. CalendarAdapter in Phase 1.
 *  Live and mock implementations satisfy the same interface; GOOGLE_MODE picks one. */
export interface AdapterFactory {
  calendar(ctx: AdapterContext): unknown;   // narrowed to CalendarAdapter in Phase 1, etc.
}
```

```ts
// src/core/contracts/store.ts
import type { Account } from './account';

export interface OrgClient { id: string; label: string; clientId: string; clientSecret: string /* decrypted in memory only */; workspaceDomain: string }

export interface Store {
  orgClients: {
    list(): Promise<Omit<OrgClient, 'clientSecret'>[]>;
    get(id: string): Promise<OrgClient | null>;
    upsert(c: Omit<OrgClient, 'id'> & { id?: string }): Promise<string>;
  };
  accounts: {
    list(): Promise<Account[]>;                 // priority order
    upsertOnConnect(a: Omit<Account, 'id' | 'priority' | 'connectedAt' | 'status'>): Promise<Account>;
    setStatus(id: string, s: Account['status']): Promise<void>;
    reorder(idsInOrder: string[]): Promise<void>;
    setLabel(id: string, label: string): Promise<void>;
  };
  tokens: {
    getRefreshToken(accountId: string): Promise<string | null>;        // decrypted
    setRefreshToken(accountId: string, token: string): Promise<void>;  // encrypted at rest
    getCachedAccess(accountId: string): Promise<{ token: string; expiresAt: number } | null>;
    setCachedAccess(accountId: string, token: string, expiresAt: number): Promise<void>;
  };
  oauth: {
    createClient(c: { redirectUris: string[]; clientName?: string }): Promise<{ clientId: string }>;
    getClient(clientId: string): Promise<{ clientId: string; redirectUris: string[] } | null>;
    saveCode(c: { codeHash: string; clientId: string; redirectUri: string; codeChallenge: string; subject: string; expiresAt: number }): Promise<void>;
    consumeCode(codeHash: string): Promise<{ clientId: string; redirectUri: string; codeChallenge: string; subject: string; expiresAt: number } | null>; // single use
    saveToken(t: { tokenHash: string; kind: 'access' | 'refresh'; clientId: string; subject: string; expiresAt: number; familyId: string }): Promise<void>;
    findToken(tokenHash: string): Promise<{ kind: 'access' | 'refresh'; clientId: string; subject: string; expiresAt: number; familyId: string; revoked: boolean } | null>;
    revokeFamily(familyId: string): Promise<void>;
    saveState(stateHash: string, data: { orgClientId: string; accountId?: string; expiresAt: number }): Promise<void>;
    consumeState(stateHash: string): Promise<{ orgClientId: string; accountId?: string; expiresAt: number } | null>;
  };
  audit: {
    write(e: { tool: string; account: string; targetId?: string; outcome: 'ok' | 'rejected' | 'error'; detail?: string }): Promise<void>; // never bodies
  };
}
```

```ts
// src/core/contracts/tool.ts
import type { z } from 'zod';
export interface ToolDef<I extends z.ZodTypeAny> {
  name: string;                    // mirrors the built-in connector's name exactly
  description: string;             // built-in description + account notes
  input: I;                        // built-in input schema + optional `account`
  kind: 'read' | 'lookup' | 'write';
  handler(input: z.infer<I>, ctx: ToolContext): Promise<unknown>;
}
export interface ToolContext { store: import('./store').Store; fanout: import('./fanout').FanOutEngine; adapters: import('./adapter').AdapterFactory; log: Logger; }
export interface Logger { info(e: LogEvent): void; warn(e: LogEvent): void; error(e: LogEvent): void }
export interface LogEvent { tool?: string; account?: string; durationMs?: number; outcome?: string; msg: string; [k: string]: unknown }
```

**Tool schemas mirror the built-ins.** Before each phase the orchestrator snapshots the built-in connector's current input schemas into `docs/builtin-tools/<product>.json` and diffs them against the spec table. Snapshots for Calendar, Gmail and Drive were taken on 2026-10-07; they're written to disk at the start of Phases 1–3. Each mirrored tool takes the built-in's input schema plus an optional `account: AccountSelector`. Excluded tools are never registered.

## 4. Phase 0 — Foundation tasks

Done when (spec): Claude connects as a custom connector; both accounts connect; `list_accounts` shows both as active.

Orchestrator additions after T0.0: `src/core/contracts/crypto.ts` (`Cipher`), `src/core/errors.ts` (`ProviderError`, `AccountSelectionError`, `GuardrailError`).

Before wave B the orchestrator added `src/server/context.ts` (composition root), `src/core/products.ts` (scope ↔ product map) and fixed-signature stubs (`src/auth/session.ts`, `src/oauth/bearer.ts`, `src/google/token-manager.ts`) that T0.5 and T0.6 replace.

Review fixes applied in wave A: no 5xx retry for POST/PATCH (duplicate-write risk); exact cross-page merge order; unique org-client labels; memory-store FK parity.

Wave B notes: `Store.oauth.revokeToken` (compare-and-set) added for refresh rotation; `TokenManager.getAccessToken(account, { forceRefresh })` added and used by the daily health check; /connect reviewed against WCAG 2.1 AA and the Web Interface Guidelines (accessible names, hover, 44px targets, dark-mode background fixed). Known limitations carried to the audit: no rate limit on `/register` and `/token`; code-reuse cannot revoke tokens issued from that code; a refresh-reuse race leaves the winner's new pair alive.

Dependency order: **T0.0 →** wave A (T0.1, T0.2, T0.3, T0.4, T0.10 in parallel) **→** wave B (T0.5, T0.6, T0.7, T0.8, T0.9 in parallel) **→** T0.11 E2E **→** audits A1 and A2 **→** T0.12 docs **→** deploy (with Seb's OK).

| Task | What | Files owned | Tests that must pass |
| --- | --- | --- | --- |
| ✅ **T0.0** Scaffold | Next.js 15 app, TS strict, ESLint, Vitest, `npm run check`; install deps (`next`, `react`, `@modelcontextprotocol/sdk`, `zod`, `@supabase/supabase-js`, `jose`); write §3 contracts verbatim; env schema `src/lib/env.ts` (zod); `.env.example` with names only; `.gitignore` covering `.env*`; GitHub Actions CI running `npm run check` | `package.json`, lockfile, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, `.gitignore`, `.env.example`, `.github/workflows/ci.yml`, `src/core/contracts/**`, `src/lib/env.ts`, `src/app/layout.tsx`, `src/app/page.tsx` | `npm run check` green on an empty suite; env schema test (missing `ENCRYPTION_KEY` fails fast outside mock mode) |
| ✅ **T0.1** Crypto and logging | `encrypt` / `decrypt` (AES-256-GCM, random 12-byte IV, `v1:` prefix, auth tag); `hashToken` (SHA-256 base64url); `randomToken`; structured JSON logger with a redaction pass (drops keys matching `token`, `secret`, `authorization`, `code`, `body`, `content`, `refresh`; truncates strings) | `src/lib/crypto.ts`, `src/lib/log.ts`, `tests/lib/**` | Round-trip; tamper detection (flipped byte throws); wrong key throws; logger never emits a seeded secret in any field (property test) |
| ✅ **T0.2** Store and schema | Supabase SQL migration: `google_org_clients`, `accounts`, `account_tokens`, `audit_log`, `oauth_clients`, `oauth_codes`, `oauth_tokens`, `oauth_state`; RLS **enabled on every table**, no policies, revoke from `anon` and `authenticated`; encrypted columns are `text` ciphertext. `MemoryStore` and `SupabaseStore` implementing `Store` (encrypts through T0.1's API, stubbed against the contract until merge). | `supabase/migrations/0001_init.sql`, `src/store/**`, `tests/store/**` | Shared `Store` conformance suite run against `MemoryStore`; SQL lint test asserting every `create table` has a matching `enable row level security`; priority ordering; `consumeCode` and `consumeState` are single use |
| ✅ **T0.3** Fan-out engine | Account resolution (label, email, list, `all`, unknown name → error listing valid labels); priority order; parallel calls with per-account timeout; merge sort newest first, ties by priority; de-dup collapsing into `accounts` and `sources`; opaque cursor (base64url JSON of `{label: pageToken}`, HMAC-signed so it can't be forged across accounts); `accountErrors` mapping; `resolveWriteAccount` | `src/core/fanout.ts`, `src/core/accounts.ts`, `src/core/cursor.ts`, `tests/core/**` | Resolution cases; merge order; ties; de-dup of the same iCalUID and start → one item with both tags and both ids; Drive file-id de-dup; cursor round trip and tamper reject; one account times out → others return and error listed; write with no account and no fallback → "which account?" error |
| ✅ **T0.4** Google HTTP and mock framework | `GoogleHttp` live implementation (fetch, bearer, timeout via `AbortSignal`, 429 / `rateLimitExceeded` backoff with full jitter, max 3 retries, maps 401 / `invalid_grant` / 403 insufficient scope to typed errors); `GOOGLE_MODE` switch; mock harness: fixture loader from `fixtures/<product>/<account>/…json`, plus fault injection per account (`invalid_grant`, `429`, `timeout`) driven by fixture metadata; identity fixtures for `stratify` and `prime` | `src/google/http.ts`, `src/google/errors.ts`, `src/google/mode.ts`, `src/google/mock/**`, `fixtures/identity/**`, `tests/google/**` | Backoff retries 3 times then throws `rate_limited`; timeout aborts; error mapping table; mock mode never touches `fetch` (test spies on `globalThis.fetch`) |
| ✅ **T0.10** Excluded-endpoint contract test | Static scan of `src/**` for banned endpoints and verbs: Gmail `messages/send`, `drafts/send`, `/trash`, `/untrash`, `delete`; Calendar `DELETE`, `sendUpdates=all\|externalOnly`, `attendees` writes; Drive `permissions` writes, `trash`, `DELETE`; `method: 'DELETE'`; plus a runtime check that the MCP tool registry contains none of the excluded tool names. Allowlist is explicit and reviewed. | `tests/contract/**` | Passes on the current tree; seeded-violation fixture (in the test itself) proves it catches each pattern |
| ✅ **T0.5** Google connect and token manager | Build the Google auth URL per org client (`access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, all scopes up front (`openid email` + calendar, gmail.modify, drive, documents, spreadsheets, presentations), hashed single-use `state`, PKCE to Google too); `/api/google/callback` exchanges the code, reads email from the ID token (verify `hd` matches the org's Workspace domain), stores the encrypted refresh token, records granted scopes, upserts the account. Token manager: cached access token → refresh → on `invalid_grant` mark `needs_reconnect` and throw a typed error. | `src/google/oauth.ts`, `src/google/token-manager.ts`, `src/app/api/google/callback/route.ts`, `src/app/api/google/connect/route.ts`, `tests/google-connect/**` | Mocked token endpoint: happy path stores an encrypted token (assert the ciphertext ≠ plaintext in the store); wrong `hd` rejected; replayed `state` rejected; `invalid_grant` → status flips; no token appears in redirects, logs or responses |
| ✅ **T0.6** OAuth 2.1 server and admin sign-in | Admin sign-in (ADR-6): `/signin`, `/api/auth/callback`, `/api/auth/signout`, `getAdminSession()`. Authorization server (ADR-7): `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/register`, `/authorize` (requires an admin session, shows a consent screen naming the client), `/token` (`authorization_code` + `refresh_token`), `verifyBearer()` used by the MCP route. | `src/auth/**`, `src/oauth/**`, `src/app/signin/**`, `src/app/api/auth/**`, `src/app/.well-known/**`, `src/app/authorize/**`, `src/app/token/**`, `src/app/register/**`, `tests/oauth/**` | PKCE: wrong verifier rejected, `plain` rejected, missing rejected; code single use; code bound to client and redirect URI; refresh rotation and reuse → family revoked; expired tokens rejected; non-allowlisted email cannot sign in; metadata documents match RFCs |
| ✅ **T0.7** MCP endpoint and `list_accounts` | `/api/mcp` (POST; GET/DELETE return 405 for stateless); bearer check via `verifyBearer`, with 401 + `WWW-Authenticate: Bearer resource_metadata=…` when missing; tool registry that only registers enabled tools; `list_accounts` returns label, email, priority, status and granted products (derived from scopes) | `src/mcp/**`, `src/app/api/mcp/route.ts`, `tests/mcp/**` | MCP `Client` lists tools → exactly `list_accounts`; calling it in mock mode returns both accounts in priority order; 401 without a token; result never contains token fields |
| ✅ **T0.8** Connect page | `/connect` (server components and server actions, admin session required): accounts table with status badge, Connect button per org client, Reconnect for `needs_reconnect`, priority reorder (up/down buttons, keyboard accessible), label edit, admin form to add or update an org client (secret field write-only and never echoed back) | `src/app/connect/**`, `src/components/**`, `tests/connect/**` | Server-action tests: unauthenticated → redirect; secret never present in rendered HTML; reorder persists. Reviewed with `design:accessibility-review` and `web-design-guidelines`. |
| ✅ **T0.9** Daily health check | `/api/cron/health` (requires `CRON_SECRET` bearer): refresh each active account's access token, mark failures `needs_reconnect`, log a summary; `vercel.json` cron once a day | `src/app/api/cron/**`, `vercel.json`, `tests/cron/**` | Mock: one account `invalid_grant` → flagged, other untouched; missing secret → 401 |
| 🟦 **T0.11** End-to-end in mock mode | One test drives the full flow: DCR → admin session (test helper) → `/authorize` with PKCE → `/token` → MCP `list_accounts` with the bearer → refresh rotation | `tests/e2e/**` | The flow passes |
| 🟦 **A1** Audit: OAuth and token security | Fresh Sonnet, read-only: T0.1, T0.2, T0.5, T0.6, T0.7 against ADR-4/6/7, OWASP ASVS auth items, the Supabase security checklist and the spec's "no tokens in logs, URLs or tool results" rule | — (findings report) | n/a; findings fixed by a fresh implementer, then re-checked |
| 🟦 **A2** Audit: guardrails and contract test | Fresh Sonnet, read-only: T0.10's scan plus the `GoogleHttp` design (no DELETE). Tries to write code that slips past the scan and reports any bypass. | — | n/a |
| **T0.12** Docs | `README.md`, `docs/RUNBOOK.md` (env vars, deploy, rotating `ENCRYPTION_KEY`, reconnecting an account, reading logs), `docs/GOOGLE_CLOUD_SETUP.md` (the spec's 7 per-org steps, expanded with exact console clicks and the redirect URI) | those three files | Docs review (`engineering:documentation`) |

**Deploy step (Phase 0 live):** needs Seb's OK at each point. Create or choose the Supabase project and apply the migration via the Supabase MCP; create the Vercel project and set env vars via the Vercel MCP; preview deploy; `engineering:deploy-checklist`; then production only with explicit approval.

**Env vars (names only; values go into Vercel, never the repo):** `GOOGLE_MODE`, `ENCRYPTION_KEY`, `SESSION_SECRET`, `CURSOR_SECRET`, `ADMIN_EMAILS`, `ADMIN_GOOGLE_CLIENT_ID`, `ADMIN_GOOGLE_CLIENT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PUBLIC_BASE_URL`, `CRON_SECRET`.

### Phase 0 live verification (for Seb, from the spec)

1. Open `/connect`, sign in, and add the Stratify and PR1ME org clients through the admin form.
2. Connect each account. Both should show **active**, Stratify at priority 1.
3. In Claude, add the custom connector at `<domain>/api/mcp` and complete the OAuth sign-in.
4. Ask Claude to call `list_accounts`. Expect both accounts, active, in the right order, with granted products.
5. Negative check: a sign-in from a non-allowlisted Google account is refused.

## 5. Later phases (detailed per phase after the previous gate)

Each phase follows the same pattern:
1. Snapshot and diff the built-in tools.
2. Define the product adapter interface.
3. Run in parallel: fixtures (two accounts, including a shared item, overlapping dates, multiple pages, `invalid_grant`, 429 and timeout), the live adapter, the mock adapter and the tool handlers.
4. Guardrail tests.
5. MCP tests.
6. Fresh-agent guardrail audit.
7. Stop for live verification.

Known items to raise when each phase starts (not decided here):
- **Phase 1:** the built-in `search_events` is semantic search on the primary calendar; the Calendar API only offers keyword `q`. **Accepted deviation** (Seb, 2026-10-07).
- **Phase 1:** the built-in uses `notificationLevel`. We force `NONE` / `sendUpdates=none` and reject `attendees`, `attendeeEmails`, `addedAttendees`, `addedAttendeeEmails`, `removedAttendeeEmails` and `guestPermissions`.
- **Phase 1:** events with other guests: blocked; the tool tells Seb what change is needed (see §7).
- **Phase 2:** the built-in `apply_sensitive_*_label` takes `TRASH` or `SPAM`. The spec includes "apply sensitive labels" but excludes trash. Seb: "fine" (2026-10-07). Read as: include the tools, SPAM allowed, TRASH still blocked per the spec's exclusion; confirm at Phase 2 start. Label tools must also refuse adding the `TRASH` label and removing it (untrash).
- **Phase 2:** open question on `create_filter`.
- **Phases 1–3:** return shapes. Input schemas are visible to me but output shapes are not. Ask Seb before guessing; one option is to call a read-only built-in tool once with his permission and record the shape.
- **Phases 4–6:** the Docs, Sheets and Slides built-in connectors aren't connected in this session, so I can't see their schemas. Seb will need to connect them or paste the tool list before those phases.

## 6. Hard rules given to every subagent

1. No excluded endpoints: send, reply, forward, trash, untrash, delete, share or permission changes, respond to events. `GoogleHttp` has no DELETE method; don't add one.
2. No attendees on calendar events, ever. Every Calendar write sends `sendUpdates=none`.
3. No tokens, secrets, authorization codes, message bodies or file contents in logs, URLs or tool results.
4. No live Google calls. Tests run with `GOOGLE_MODE=mock` and must not touch the network.
5. Edit only the files you own. Ask the orchestrator for dependency or contract changes.
6. No secrets in the repo, including test fixtures (use obviously fake values).
7. Every write is logged to `audit_log` (tool, account, target id, outcome) and never fans out.

## 7. Decisions on design calls

- ADR-6 separate admin sign-in client: **approved** (Seb, 2026-10-07).
- ADR-8 OAuth tables added to the data model: **approved** (Seb, 2026-10-07).

## 8. Open questions (from the spec), and when they get asked

| Question | Ask at | Answer |
| --- | --- | --- |
| Scopes: phase by phase, or all six products up front? | Phase 0 (connect flow) | **All six up front** (Seb, 2026-10-07). Connect requests every scope in the spec's scope table; tools still ship phase by phase. |
| Server domain: subdomain or default Vercel URL? | Phase 0 (redirect URIs, OAuth metadata) | **`mcp.stratifysoftware.com`** (Seb, 2026-10-07). Needs a DNS CNAME to Vercel; `PUBLIC_BASE_URL=https://mcp.stratifysoftware.com`. |
| Repo | — | `stratifysebastian/superconnector` |
| Calendar updates on events with other guests | Phase 1 | **Block** (Seb, 2026-10-07). `update_event` never changes an event with other guests; it returns a plain-language result telling Seb what change is needed so he can make it himself. |
| Gmail `create_filter` | Phase 2 | _pending_ |
