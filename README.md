# Superconnector

A remote MCP server that gives Claude its Google tools across several Google Workspace accounts at once, with the account as a tool parameter. It runs as one Next.js 15 app on Vercel, with Supabase (Postgres) holding the account registry and encrypted tokens.

It never sends, forwards, replies, trashes, deletes, shares, invites or RSVPs. Those endpoints are blocked in the server itself, not left to the agent (see [How guardrails are enforced](#how-guardrails-are-enforced)).

Current state: Phase 0 (foundation). The only registered MCP tool is `list_accounts`. Calendar, Gmail, Drive, Docs, Sheets and Slides tools arrive phase by phase; see `docs/PLAN.md`.

## Architecture

One app serves four surfaces:

| Surface | Routes | Purpose |
| --- | --- | --- |
| MCP endpoint | `POST /api/mcp` | Streamable HTTP, stateless. Needs a bearer token from the OAuth server. GET and DELETE return 405. |
| OAuth 2.1 server for Claude | `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/register`, `/authorize`, `/token` | Dynamic client registration, authorization code with PKCE (S256 only). Access tokens last 1 hour, refresh tokens 30 days, rotated on use. Only allowlisted admins can authorize. |
| Connect page | `/connect`, `/signin`, `/api/auth/start`, `/api/auth/callback`, `/api/auth/signout`, `/api/google/connect` | Admin sign-in (Google OIDC, `openid email`, allowlist `ADMIN_EMAILS`), then manage accounts and org clients. |
| Google OAuth callback | `/api/google/callback` | Exchanges the code, checks the Workspace domain, stores the encrypted refresh token. |

There is also `GET /api/cron/health`, the daily health and cleanup job (see `docs/RUNBOOK.md`).

Supabase tables (`supabase/migrations/0001_init.sql`, row level security enabled on all, no policies; only the service role connects):

- `google_org_clients`: one row per Workspace org (label, client ID, encrypted client secret, domain).
- `accounts`: connected Google accounts (email, label, priority, status `active` or `needs_reconnect`, granted scopes).
- `account_tokens`: encrypted refresh token, cached access token and expiry.
- `audit_log`: write-call log (tool, account, target id, outcome). No bodies.
- `oauth_clients`, `oauth_codes`, `oauth_tokens`, `oauth_state`: the OAuth server's registrations, single-use codes, hashed tokens, and Google-connect CSRF state.

Secrets are encrypted in the app with AES-256-GCM (`ENCRYPTION_KEY`) before they reach Supabase.

## Local development

Requires Node 22 or later.

```bash
npm ci
GOOGLE_MODE=mock npm run dev
```

`GOOGLE_MODE=mock` needs no Google credentials and no Supabase. It uses an in-memory store, random per-process secrets for anything you leave unset, and never calls Google.

What mock mode seeds on start (`src/google/mock/seed.ts`): two fake org clients and two connected accounts, both with all six products granted:

| Label | Email | Domain |
| --- | --- | --- |
| `stratify` | `seb@stratify.example` | `stratify.example` |
| `prime` | `seb@prime.example` | `prime.example` |

Fault injection for the mock accounts (`invalid_grant`, rate limited, timeout) is read from `fixtures/faults.json` (empty by default).

Limits of local mode:

- Admin sign-in has no mock. `/signin`, and so `/connect` and `/authorize`, answer 503 "Admin sign-in is not configured" unless you set `ADMIN_EMAILS`, `ADMIN_GOOGLE_CLIENT_ID` and `ADMIN_GOOGLE_CLIENT_SECRET` to a real sign-in client (see `docs/GOOGLE_CLOUD_SETUP.md`, "Admin sign-in client") with `http://localhost:3000/api/auth/callback` registered. Without them, the tests are the way to exercise the flow: `tests/e2e/oauth-mcp.test.ts` drives registration, authorize, token, refresh and `list_accounts` in-process.
- `GOOGLE_MODE` must be set explicitly when `VERCEL_ENV` is set or `NODE_ENV` is `production`, and `mock` is refused when `VERCEL_ENV=production`.

Copy `.env.example` to `.env.local` for the variable names. Never commit real values; `.env*` is git-ignored.

Run everything CI runs:

```bash
GOOGLE_MODE=mock npm run check   # lint, typecheck, vitest
```

CI (`.github/workflows/ci.yml`) also runs `npm run build`.

## Repo layout

```
src/app/            Next.js routes (api/mcp, api/auth, api/google, api/cron, connect, signin, authorize, token, register, .well-known)
src/auth/           Admin sign-in, session cookie, allowlist
src/oauth/          OAuth 2.1 server: metadata, register, authorize, token, bearer check
src/mcp/            MCP handler, tool registry, tools (list_accounts)
src/core/           Contracts (src/core/contracts), fan-out engine, account resolution, cursors, products and scopes, errors
src/google/         oauth.ts (connect flow), token-manager.ts, http.ts (the only Google HTTP client),
                    endpoints/ (runtime endpoint policy), mock/ (mock mode)
src/store/          Store interface implementations: memory and Supabase
src/cron/           Daily health check and cleanup
src/lib/            env.ts, crypto.ts, log.ts
src/components/     /connect page components
supabase/migrations/  SQL schema
fixtures/           Mock-mode fixtures
tests/              Vitest suites; tests/contract holds the guardrail scan
docs/               SPEC.md, PLAN.md, RUNBOOK.md, GOOGLE_CLOUD_SETUP.md
```

## How guardrails are enforced

The guardrails live in the server. Three layers back each other up.

1. **Runtime endpoint policy, deny by default** (`src/google/endpoints/`). Every Google request passes `checkRequest` in `GoogleHttp` before it is sent. A request is rejected unless it uses GET, POST, PATCH or PUT (there is no DELETE), passes the universal checks, and matches an explicit rule in `ENDPOINT_RULES` on method, host and path. The universal checks (`guards.ts`) apply even when a rule matches: no trash, untrash, delete, import, send, batch, ACL or permission writes; no Gmail settings; no `TRASH` label; no `trashed: true`; no attendee fields or `responseStatus` in any body; Calendar writes need `sendUpdates=none`; no method-override parameters; no redirects. `ENDPOINT_RULES` is empty in Phase 0, so no Google API call is possible yet.
2. **Contract scan** (`tests/contract/`). A static scan of `src/**` fails the test run if code outside the policy files names an excluded endpoint or verb, calls a Google host or path outside `src/google/endpoints/`, imports `googleapis`, or uses a raw network client. The pattern list and the small reviewed allowlist are in `tests/contract/excluded.ts`.
3. **Enabled-tool allowlist** (`tests/contract/enabled.ts`). `ENABLED_TOOL_NAMES` is the complete list of registered MCP tools. `enabled.test.ts` compares it with the real registry exactly, so a tool cannot be registered unless it is listed here, and excluded tool names (`send_message`, `reply`, `forward`, `delete_event`, `share_file` and so on) can never appear.

### Adding endpoints in a later phase

1. Add rules for the product in `src/google/endpoints/<product>.ts` (for example `calendar.ts`), each an `EndpointRule` with `id`, `product`, `method`, `host`, an anchored `path` regex, and `allowedQuery`, `requiredQuery` or `checkBody` where useful. Spread them into `ENDPOINT_RULES` in `src/google/endpoints/index.ts`.
2. Register the tools and add their exact names to `ENABLED_TOOL_NAMES` in `tests/contract/enabled.ts` in the same change.
3. Add runtime rejection cases to `tests/google/http.test.ts`. If a new excluded pattern is needed, add it to `tests/contract/excluded.ts`.
4. Run `GOOGLE_MODE=mock npm run check`.

## Documentation

- `docs/SPEC.md`: the build spec (source of truth).
- `docs/PLAN.md`: the build plan, architecture decisions and audit outcomes.
- `docs/GOOGLE_CLOUD_SETUP.md`: Google Cloud and Workspace admin setup per org, and the admin sign-in client.
- `docs/RUNBOOK.md`: environment variables, first deploy, operating procedures, security notes.
