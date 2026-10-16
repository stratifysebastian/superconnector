# Build Plan — Multi-Account Google Connector

Source of truth: `docs/SPEC.md`. If this plan conflicts with the spec, the spec wins.

Status legend: ⬜ not started · 🟦 in progress · ✅ done (merged, tests green) · ⛔ blocked

| Phase | Status |
| --- | --- |
| 0 Foundation | ✅ live-verified 2026-10-16 (Claude connector + `list_accounts`: stratify #1, prime #2, both active, 6 products); non-allowlist sign-in refused (2026-10-16: Google blocked a personal Gmail with `org_internal`, because the admin client is Internal to the Stratify Workspace; the `ADMIN_EMAILS` check is covered by tests) |
| 1 Calendar | ✅ live-verified 2026-10-16 (PR #3): Stratify week (21 events, matched the built-in) and PR1ME week read; create with a guest refused; guest-free test event created and renamed on Stratify; moving a guest event refused with the change described. Not yet seen live: a meeting on both calendars collapsing into one (covered in mock tests). |
| 2 Gmail | ✅ live-verified 2026-10-16 (PR #4): search across both accounts, reply draft in the right PR1ME thread, label create/rename/apply/remove, trash and send refused |
| 3 Drive | ✅ live-verified 2026-10-16 (PR #5): recent files across both accounts, Doc and PDF read, create/rename/move into a private folder, move into a shared folder refused, share and trash refused |
| 4 Docs | ⏸ paused by Seb (2026-10-16) for `send_self_report` (§4e). Also blocked on the built-in Docs schemas. |
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

Audit outcomes: A1 (OAuth/token) found no Critical/High; Mediums M1–M3 and Lows L1, L2, L5–L10 are fixed in H2/H3 (store additions `revokeAllTokens`, `purgeExpired`, `countClients`, `clientName` and malformed-id handling were made by the orchestrator). Accepted and documented, not fixed: L3 refresh-race winner keeps its pair; L4 code reuse cannot revoke issued tokens; L11 no AAD binding on ciphertext (needs DB write access); L12 allowlist keyed on email, not Google `sub`. A2 re-audit (after H1): 0 of 62 bypasses pass the combined scan and runtime defence; its remaining gaps are fixed in H4. Pending Seb at deploy: a Vercel WAF rate limit on `/register` and `/token`. A2 (guardrails) showed 47/62 bypass snippets passed the text scan; H1 makes the guardrail structural.

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
| ✅ **T0.11** End-to-end in mock mode | One test drives the full flow: DCR → admin session (test helper) → `/authorize` with PKCE → `/token` → MCP `list_accounts` with the bearer → refresh rotation | `tests/e2e/**` | The flow passes |
| ✅ **A1** Audit: OAuth and token security | Fresh Sonnet, read-only: T0.1, T0.2, T0.5, T0.6, T0.7 against ADR-4/6/7, OWASP ASVS auth items, the Supabase security checklist and the spec's "no tokens in logs, URLs or tool results" rule | — (findings report) | n/a; findings fixed by a fresh implementer, then re-checked |
| ✅ **A2** Audit: guardrails and contract test | Fresh Sonnet, read-only: T0.10's scan plus the `GoogleHttp` design (no DELETE). Tries to write code that slips past the scan and reports any bypass. | — | n/a |
| ✅ **H1** Guardrail hardening (from A2) | Remove `getAccessToken` from `AdapterContext`; deny-by-default runtime endpoint policy in `GoogleHttp` (`src/google/endpoints/`), hard bans, universal body checks, snapshot inputs, no override params, `redirect: 'error'`, drop oauth2 host; scan becomes deny-by-default for Google paths outside `src/google/endpoints/**`; enabled-tool allowlist test | `src/google/http.ts`, `src/google/endpoints/**`, `src/core/contracts/adapter.ts`, `tests/google/http.test.ts`, `tests/contract/**` | Runtime rejection table for every audit bypass class; seeded scan cases |
| ✅ **H2** Auth and env hardening (from A1) | M1 fail-closed mock mode + per-process random mock secrets; L6 HKDF subkeys; L7 RFC 9207 `iss`; L2 full redirect URI and unverified label on consent; M3 cap at 200 clients; L8 `CRON_SECRET` ≥ 32 and https-origin `PUBLIC_BASE_URL`; L1 security headers; L9 `Sec-Fetch-Site` on connect; L10 timeouts | `src/lib/env.ts`, `src/auth/**`, `src/oauth/**`, `src/google/oauth.ts`, `src/google/token-manager.ts`, `src/server/context.ts`, `next.config.ts`, connect route, their tests | One test per fix |
| ✅ **H3** Kill switch and cleanup (from A1) | M2 "Revoke all Claude access" on /connect with confirmation and audit entry; M3 daily `purgeExpired` in the cron | `src/cron/**`, `src/app/connect/**`, `src/components/**`, their tests | Revoke and cleanup tests |
| ✅ **T0.12** Docs | `README.md`, `docs/RUNBOOK.md` (env vars, deploy, rotating `ENCRYPTION_KEY`, reconnecting an account, reading logs), `docs/GOOGLE_CLOUD_SETUP.md` (the spec's 7 per-org steps, expanded with exact console clicks and the redirect URI) | those three files | Docs review (`engineering:documentation`) |

**Live (2026-10-16):** production on `main` at https://mcp.stratifysoftware.com. Fixes found during live bring-up: accept `SUPABASE_SECRET_KEY`; migration applied to Supabase project `znsqkaxfvawciwppgzve` (ca-central-1, Vercel-integration org); `Referrer-Policy: same-origin` (no-referrer made browsers send `Origin: null`, breaking consent approval). Firewall rate limit on `/register` and `/token` still to do: the Vercel API returns 404 "Seawall Config not found" for GET, PATCH and PUT, so Seb adds it in the dashboard (custom rule: path is `/register` or `/token`, rate limit 20 per 60 s per IP, deny).

**Deploy status (2026-10-07):**
- Branch `main` created from the spec commit; Phase 0 is in PR stratifysebastian/superconnector#1 (production deploys from `main`).
- Vercel project `superconnector` (team sebastian-4409's projects, `prj_YWIR9dwMIDkYukJwGuQYxid7WG0a`) is linked to the repo. Domain `mcp.stratifysoftware.com` is added and verified, but the DNS CNAME is still pending.
- Env vars set:
  - Production: `GOOGLE_MODE=live`, `STORE=supabase`, `PUBLIC_BASE_URL`, `ENCRYPTION_KEY`, `SESSION_SECRET`, `CURSOR_SECRET` and `CRON_SECRET` (all four secrets marked sensitive).
  - Preview: `GOOGLE_MODE=mock`, with no admin allowlist.
- Pending:
  - The Supabase project. MCP `create_project` timed out twice and created nothing.
  - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
  - `ADMIN_EMAILS`, `ADMIN_GOOGLE_CLIENT_ID` and `ADMIN_GOOGLE_CLIENT_SECRET`.
  - Merging the PR.
  - The Vercel firewall rate limit on `/register` and `/token` (Seb approved it).

**Deploy step (Phase 0 live):** needs Seb's OK at each point. Create or choose the Supabase project and apply the migration via the Supabase MCP; create the Vercel project and set env vars via the Vercel MCP; preview deploy; `engineering:deploy-checklist`; then production only with explicit approval.

**Env vars (names only; values go into Vercel, never the repo):** `GOOGLE_MODE`, `ENCRYPTION_KEY`, `SESSION_SECRET`, `CURSOR_SECRET`, `ADMIN_EMAILS`, `ADMIN_GOOGLE_CLIENT_ID`, `ADMIN_GOOGLE_CLIENT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PUBLIC_BASE_URL`, `CRON_SECRET`.

### Phase 0 live verification (for Seb, from the spec)

1. Open `/connect`, sign in, and add the Stratify and PR1ME org clients through the admin form.
2. Connect each account. Both should show **active**, Stratify at priority 1.
3. In Claude, add the custom connector at `<domain>/api/mcp` and complete the OAuth sign-in.
4. Ask Claude to call `list_accounts`. Expect both accounts, active, in the right order, with granted products.
5. Negative check: a sign-in from a non-allowlisted Google account is refused.

## 4b. Phase 1 — Calendar (✅ live-verified 2026-10-16)

Done when (spec): the morning brief shows events from both accounts, with shared meetings shown once carrying both tags; and `create_event` with attendees is rejected.

**Tools:** `list_calendars`, `list_events`, `search_events`, `get_event`, `suggest_time`, `create_event`, `update_event`.
- Each takes the built-in input schema (`docs/builtin-tools/calendar.json`) plus `account`.
- Each returns the built-in shape plus `account`/`accountEmail`; de-duplicated events also carry `accounts`/`sources`.
- Reads also return `accountErrors` and `nextCursor`.

**Behaviour per tool:**

| Tool | Accounts | Behaviour |
| --- | --- | --- |
| `list_calendars` | fan-out | Merged list, each calendar tagged with its account. |
| `list_events` | fan-out | Merged **earliest first** by start time (Seb, 2026-10-16; deviates from the spec's newest-first, Calendar only). Each account is fetched with `orderBy=startTime` so paging stays exact; the `orderBy` input is accepted but ignored. Events de-duplicated on `iCalUID` + start. |
| `search_events` | fan-out | Same merge and de-duplication. Uses the Calendar API's keyword `q` on each primary calendar (accepted deviation from the built-in's semantic search). |
| `get_event` | lookup | Finds the event in whichever account has it. |
| `suggest_time` | fan-out | Combines free/busy across all of Seb's calendars and the given attendees. Returns free slots. |
| `create_event` | one account | Account required; otherwise a "which account?" error. Any attendee field is rejected. Sent with `sendUpdates=none`. Audited. |
| `update_event` | one account | Defaults to the event's own account. Fetches the event first. If it has guests other than Seb, the change is refused and the tool reports what change Seb needs to make himself. Attendee fields rejected, `sendUpdates=none`, audited. |

**Built-in fields:**
- `notificationLevel` is ignored and always forced to `NONE`.
- `attendees`, `attendeeEmails`, `addedAttendees`, `addedAttendeeEmails`, `removedAttendeeEmails` and `guestPermissions` are rejected with a plain-language error.

**Tasks** (Sonnet subagents in parallel worktrees, with exclusive files):

| Task | Scope |
| --- | --- |
| C1 Fixtures + mock adapter | `fixtures/calendar/{stratify,prime}/`. Includes: the same meeting on both accounts (same `iCalUID`), overlapping dates, multiple pages, `invalid_grant`, 429 and timeout. Plus `src/google/mock/calendar.ts`. |
| C2 Live adapter + endpoint rules | `src/google/calendar.ts` (`CalendarAdapter`) and `src/google/endpoints/calendar.ts`. Rules are anchored with explicit `allowedQuery`. The writes are `events` POST and `events/{id}` PATCH with `requiredQuery: { sendUpdates: 'none' }`, plus `freeBusy` POST. The orchestrator first adds the `CalendarAdapter` contract and wires `GoogleHttp` and the token manager into `AdapterContext`. |
| C3 Tool handlers | `src/mcp/tools/calendar/*`, the registry, and `tests/contract/enabled.ts`. |
| C4 Guardrail and MCP tests | Attendees rejected on create and update. Updates to guest events refused. `sendUpdates=none` on every write. Excluded tools absent. Fan-out, de-duplication and paging through the MCP client in mock mode. |
| ✅ A3 Audit | A fresh agent reviews the Calendar guardrails and endpoint rules. **Done 2026-10-16.** No bypass of attendees, `sendUpdates=none`, delete/cancel/respond, logging or account isolation. Fixed: `update_event` now also refuses when Google hides guests (`attendeesOmitted`, or we are a guest with `guestsCanSeeOtherGuests=false`) (medium); `eventType` limited to `default`/`workingLocation`, since out-of-office and focus time can auto-decline invitations (low). Open for Seb: events whose only other attendee is a booked room count as guest-free. Info only: cursors are not bound to the query and never expire; an audit-store failure after a successful create reports an error. |

**Live verification (with Seb):**
1. Ask Claude for this week's events. Both accounts should appear, and a meeting on both calendars should show once with both tags.
2. Ask it to create an event with an attendee. It must be refused.
3. Create a guest-free test event on Stratify, and update it.
4. Try to update an event that has other guests. It must be refused, with the change described.

`suggest_time` shape observed once with Seb's approval (`{ timeSlots: [{ start, end, startTime, endTime, durationMinutes }] }`), recorded in `docs/builtin-tools/calendar.json`.

Orchestrator contract (done): `src/core/contracts/calendar.ts` (`CalendarAdapter`, `GEvent`, `EventWriteBody` with no attendee or notification fields), `AdapterFactory.calendar` narrowed, `ToolContext.adapterContext(account)` wired to a guarded `GoogleHttp` per account.

## 4c. Phase 2 — Gmail (✅ live-verified 2026-10-16)

**Tools (21):**
- Reads: `search_threads`, `get_thread`, `get_message`, `list_drafts`, `get_draft` and `list_labels`.
- Drafts: `create_draft` (new, or a reply when `replyToMessageId` is given) and `update_draft`.
- Labels: `create_label`, `update_label`, `label_message`, `label_thread`, `unlabel_message`, `unlabel_thread` and `update_message_labels`.
- Spam: `apply_sensitive_message_label`, `apply_sensitive_thread_label`, `mark_message_spam`, `mark_thread_spam`, `unmark_message_spam` and `unmark_thread_spam`.

Each takes the built-in input schema plus `account`. Input schemas were captured from the built-in connector on 2026-10-16. Read output shapes observed 2026-10-16 (Seb approved; `docs/builtin-tools/gmail.json`). Write outputs were not observed. Drafts return the Draft shape; label and spam tools return the modified message or thread. `includeSignature` is accepted but ignored, because signatures live in Gmail settings, which stay banned.

**Excluded:** `send_message`, `reply`, `forward`, `trash_*`, `untrash_*`, `delete_draft` and `delete_label`.
- `create_filter`: **skipped for now** (Seb, 2026-10-16). It is not in the current built-in Gmail connector. It also needs the `gmail.settings.basic` scope, which means a reconnect, and it needs the Gmail-settings hard ban loosened. It is on hold until Seb confirms.

**Accounts:**

| Tool | Accounts | Behaviour |
| --- | --- | --- |
| `search_threads`, `list_drafts` | fan-out | Merged newest first by the latest message date. Not de-duplicated: the same email in both inboxes is two separate copies, each tagged with its account. |
| `list_labels` | fan-out | Each label tagged with its account. |
| `get_thread`, `get_message`, `get_draft` | lookup | Tries accounts in priority order. |
| Writes | one account | Defaults to the account that holds the message, thread or draft (found by lookup); `create_label` needs an account. Audited. |

**Guardrails:**
- Runtime endpoint rules cover only: `threads` list/get, `messages` get, `drafts` list/get/create/update, `labels` list/create/patch, and `messages`/`threads` `modify`.
- Hard bans stay in place: `send`, `insert`, `import`, `watch`, `settings` and every DELETE.
- Modify body check: neither `addLabelIds` nor `removeLabelIds` may contain `TRASH`, which blocks both trash and untrash. `SPAM` is allowed.
- `apply_sensitive_*_label` with `TRASH` is refused before any call is made.
- Drafts are only created or updated, never sent. A reply draft carries the original `threadId` plus `In-Reply-To` and `References` headers, so it sits in the right thread of the right account.
- Logs and audit entries never contain bodies, subjects, snippets or recipients.

**Tasks:**

| Task | Scope |
| --- | --- |
| ✅ G1 | Fixtures and mock adapter. Two accounts, including the same email received by both, multiple pages, `invalid_grant`, 429 and timeout. |
| ✅ G2 | Live adapter and endpoint rules: MIME building for drafts, and thread metadata fetches for search. The orchestrator adds the `GmailAdapter` contract first. |
| ✅ G3 | Tool handlers. |
| ✅ G4 | Guardrail and MCP tests (15 end-to-end cases in mock mode). |
| ✅ A4 | Fresh-agent audit of the Gmail guardrails. **Done 2026-10-16.** No path to send, trash, delete or settings across 43 bypass attempts. No MIME header injection, and account isolation holds. Fixed: a quoted display name could steer a reply draft's `To` (medium); downstream policy blocks are now audited `rejected` and carry the hand-back text (low); double-encoded paths (`%25`) are refused (info). Not fixed (info): lookalike label ids such as zero-width + TRASH pass the policy, but Google treats them as unknown labels; attachment content has no size cap; un-spamming a whole thread moves sent messages to the inbox too. |

**Live verification (with Seb):**
1. Search with no account: mail from both accounts, newest first.
2. Create a reply draft to a real thread on PR1ME. It should sit in that thread, unsent.
3. Create and rename a test label, and label then unlabel a message.
4. Ask to trash a message. It must be refused.
5. Ask to send the draft. Nothing should send it.

## 4d. Phase 3 — Drive (✅ live-verified 2026-10-16)

**Tools (9).** The built-in Drive connector minus `share_file` and `trash_file`. Each takes the built-in input schema (captured 2026-10-16) plus `account`.
- **Reads:** `search_files`, `list_recent_files`, `get_file_metadata`, `get_file_permissions`, `read_file_content` and `download_file_content`.
- **Writes:** `create_file`, `copy_file` and `update_file` (title, description and parent folder only, as in the built-in).

**Accounts:**

| Tool | Accounts | Behaviour |
| --- | --- | --- |
| `search_files`, `list_recent_files` | fan-out | Merged newest first by `modifiedTime`. A file visible to both accounts (same file id) appears once, with `accounts` and `sources`. |
| `get_file_metadata`, `get_file_permissions`, `read_file_content`, `download_file_content` | lookup | Tries accounts in priority order. |
| `create_file` | one account | An account is required. |
| `copy_file`, `update_file` | one account | Defaults to the account that can see the file. |

**Query translation.** `search_files` takes the built-in's query syntax (`title`, `fullText`, `mimeType`, `parentId`, `owner`, `sharedWithMe`, `starred`, plus times) and translates it into Drive v3 `q`, for example `name contains`, `'id' in parents` and `'x' in owners`. Anything outside that grammar is refused, never passed through.

**Binary content.** `GoogleHttp` only does JSON, so it gains two narrow methods behind the same endpoint policy.
- **`upload`:** multipart/related to `upload/drive/v3/files` with `uploadType=multipart`. The metadata part is body-checked like any other JSON body.
- **`download`:** `files/{id}?alt=media`, and `files/{id}/export` for Google-native files.
- **Size cap:** Vercel limits a function's request and response to about 4.5 MB, so uploads are capped at 3 MB raw, and reads and downloads at 1.5 MB, because results are sent twice (A5). Bigger files get a plain error with the file's Drive link.

**Decisions (Seb, 2026-10-16):**
- `read_file_content` exports Google-native files as text and parses PDFs with `unpdf` (one new dependency). Images come back as MCP image content. Office files return a plain message pointing to `download_file_content`.
- `create_file`, `copy_file` and `update_file` refuse a destination folder that is shared with anyone other than the account owner. My Drive root is fine.
- Output shapes were observed read-only and are recorded in `docs/builtin-tools/drive.json`.

**Snippets (revised at build time).** The Drive API has no content snippets. `excludeContentSnippets` and `snippetVerbosity` are accepted. Only `get_file_metadata` returns a `contentSnippet`: the start of a Google-native file's plain-text export, cut to the verbosity limit. `search_files` and `list_recent_files` return none, because one export per result would be too slow for a function call.

**Ordering.** Drive can't sort `fullText` searches; they come back in relevance order. Those merged results are listed account by account, in priority order, which keeps paging exact. All other searches merge newest first by `modifiedTime`. `list_recent_files` merges on the same time field Drive sorted by.

**Guardrails:**
- No `permissions` writes, ever: the GET of a file's permissions is the only permissions rule.
- No trash, delete, `emptyTrash`, `transferOwnership` or `changes/watch`.
- The update body is whitelisted to `name`, `description` and `addParents`/`removeParents`. `writersCanShare`, `copyRequiresWriterPermission`, `trashed` and `permissions` can never be set, nor can any other key.
- The copy body is limited to `name` and `parents`.
- `supportsAllDrives` is allowed on reads only. Writes into shared drives are refused.
- Logs and audit entries never contain file content, names or queries.

**Tasks:** D0 (orchestrator) does the `GoogleHttp` upload and download plus the `DriveAdapter` contract. Then:

| Task | Scope |
| --- | --- |
| ✅ D1 | Fixtures and mock. |
| ✅ D2 | Live adapter and endpoint rules. |
| ✅ D3 | Tool handlers. |
| ✅ D4 | End-to-end tests. |
| ✅ A5 | Fresh audit, with OAuth/token re-check of the new transport. **Done 2026-10-16.** No permission writes, trash or delete. The query translator can't emit arbitrary Drive queries. The transport is sound: no header or boundary injection, the byte cap holds, no token in logs, no duplicate creates. Fixed: **(high)** `copy_file` with `parentId: ""` skipped the shared-folder check. **(medium)** `isSharedFolder` now fails closed (empty list, shared drive or non-folder all count as shared), and `supportsAllDrives` is removed from writes. **(medium)** PDFs are capped at 1 MB and 100 pages, with page-by-page extraction. **(low)** A write-account lookup error now asks which account instead of silently using the other one (Drive, Gmail and Calendar). **(low)** Image results are validated. **(low)** The read/download cap is lowered to 1.5 MB, because results are sent twice (text plus structured). Known residual: pdf.js runs in-process, so a PDF bomb under 1 MB can still use a lot of memory; the upgrade is a worker with a hard timeout. |

**Live verification (with Seb):**
1. Search with no account: files from both accounts, newest first, and a file shared between them shown once.
2. Read a Google Doc and a PDF.
3. Create a text file on Stratify, rename it and move it to another of your folders.
4. Ask to share it, or to trash it. Both must be refused.

## 4e. `send_self_report` (✅ live-verified 2026-10-16, PR #6)

Source: `docs/MIGRATION.md`, Part 1, Option B. This tool is a **deliberate, owner-approved exception** to the spec's "never send". The invariant it keeps: **this server cannot email anyone other than the account's own address.** Docs, Sheets and Slides are paused until it ships.

**Tool:** `send_self_report({ account, subject, body, htmlBody? })`.
- There is no `to`, `cc`, `bcc`, `replyTo`, `from`, `headers`, `threadId` or `attachments` field; unknown keys are rejected (`strict`).
- `account` is required and must name exactly one account. Fan-out is refused.
- `body` (plain text) is required. A `<` anywhere in it is refused.
- It returns `{ sent: true, to: <account email>, messageId, sentToday, dailyLimit }`.

**How the guarantee is made structural, not just in the prompt:**
1. **No adapter can send.** The only send path is a new `GoogleHttp.sendToSelf({ subject, body, htmlBody })`. It builds the MIME itself from the account's own email, which `GoogleHttp` receives when it is created per account and which is never caller input. `From` and `To` are both that address. There is no Cc, Bcc or Reply-To, and CR/LF are stripped from the subject.
2. **The policy checks the result.** A dedicated `self-send` transport rule matches only `POST /gmail/v1/users/me/messages/send`. Its body check decodes the raw MIME, and requires all of these:
   - exactly one `To` and one `From`, both equal to the account email;
   - no `Cc`, `Bcc`, `Resent-*`, `Reply-To` or `Disposition-Notification-To` header;
   - no `threadId`;
   - nothing else in the body.

   The existing `gmail-send` hard ban stays in force for `json`, `upload` and `download`, so `drafts/send` remains impossible.
3. **The daily cap is server-side.** The limit is 6 per account per calendar day. The count comes from `audit_log` rows for this tool: a row is written *before* sending (a reservation), then the count is read back. A seventh concurrent call sees 7 and is refused. A reservation followed by a failed send still counts, so the cap errs towards fewer sends, never more. No schema change is needed.
4. The contract scan keeps `send_message`, `send_draft`, `reply`, `reply_all` and `forward` banned. Only `send_self_report` is added to the enabled list, and the `messages/send` literal is exempt in exactly one file.

**Scope:** `gmail.modify`, already granted, permits `messages.send`, so no reconnect is needed.

**Self-check:** assert-based tests cover:
- no account is refused;
- a `<` in `body` is refused;
- the seventh send in a day is refused;
- the resolved recipient equals the account's address;
- any attempt to smuggle a recipient is refused by the schema, by `sendToSelf` and by the policy.

There are also policy tests showing that hand-built raw MIME with a different `To`, or with an added `Bcc`, is denied.

**Testing rule:** mock only. Nothing is ever sent by me; Seb sends the first live one.

**Audit A6 (2026-10-16):** no way found to reach anyone but the account itself.
- Probed with a 120-message hostile-content fuzz through the real path, checked by an independent strict MIME parser, plus a policy matrix of 2 hosts × 19 paths × 4 transports × 4 methods. Exactly one combination passes.
- The reserve-then-count cap held under 20 parallel calls.
- Fixed:
  - (low) the checker now requires CRLF-only line breaks, so a stray CR can't end its header block early;
  - (info) the size cap counts bytes.
- Not fixed:
  - (low) an admin rename resets that day's count; this needs the admin session (shortcut comment in code);
  - (low) the cap lives in the tool handler, but no other caller of `sendToSelf` exists;
  - (low) refused calls past the cap still add audit rows.

**Decisions (Seb, 2026-10-16):**
- Design approved.
- The daily cap resets at midnight America/Toronto.
- Seb sends the first live report himself.
- The edits to the trigger prompts and the Drive config in `docs/MIGRATION.md` Parts 2–5 are drafted as diffs for Seb's OK after the tool is live, then applied in one pass.

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
- **Phase 2:** the built-in `apply_sensitive_*_label` takes `TRASH` or `SPAM`. The spec includes "apply sensitive labels" but excludes trash. Seb: "fine" (2026-10-07). Read as: include the tools, SPAM allowed, TRASH still blocked per the spec's exclusion; **Confirmed by Seb 2026-10-16.** Label tools must also refuse adding the `TRASH` label and removing it (untrash).
- **Phase 2:** `create_filter` skipped for now (Seb, 2026-10-16).
- **Phases 1–3:** return shapes. Input schemas are visible to me but output shapes are not. Ask Seb before guessing; one option is to call a read-only built-in tool once with his permission and record the shape.
- **Phase 3 (Drive):** `GoogleHttp` only does JSON, so content upload, `alt=media` download and export need a non-JSON path designed in the same policy layer. Also decide whether to ban Drive `writersCanShare` and `copyRequiresWriterPermission` changes (they change sharing capability without touching permissions).
- **Phases 5–6:** Sheets and Slides `batchUpdate` can delete content (`deleteSheet`, `deleteObject`, `values:batchClear`). The spec's "no trash or delete" is about files; confirm with Seb that content edits inside a file are allowed.
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
- Calendar: a booked room does not count as a guest, so such events stay editable (Seb, 2026-10-16).
- Refusals to invite or to change guest events tell Claude that Seb does these himself and not to use another connector (Seb, 2026-10-16), after Claude offered the built-in connector during live testing.
- Calendar merged order: **earliest first** (Seb, 2026-10-16). C4 found that newest-first merging over Google's ascending `startTime` pages skipped events across pages. Calendar tools negate `dateOf` and always request `orderBy=startTime`. Gmail and Drive stay newest first.

## 8. Open questions (from the spec), and when they get asked

| Question | Ask at | Answer |
| --- | --- | --- |
| Scopes: phase by phase, or all six products up front? | Phase 0 (connect flow) | **All six up front** (Seb, 2026-10-07). Connect requests every scope in the spec's scope table; tools still ship phase by phase. |
| Server domain: subdomain or default Vercel URL? | Phase 0 (redirect URIs, OAuth metadata) | **`mcp.stratifysoftware.com`** (Seb, 2026-10-07). Needs a DNS CNAME to Vercel; `PUBLIC_BASE_URL=https://mcp.stratifysoftware.com`. |
| Repo | — | `stratifysebastian/superconnector` |
| Calendar updates on events with other guests | Phase 1 | **Block** (Seb, 2026-10-07). `update_event` never changes an event with other guests; it returns a plain-language result telling Seb what change is needed so he can make it himself. |
| Gmail `create_filter` | Phase 2 | First answered "include, no forward or delete"; then **skipped for now** (Seb, 2026-10-16), after learning it is not in the built-in and needs a new scope plus a reconnect. |
