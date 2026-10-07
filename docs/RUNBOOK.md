# Runbook

Operating the Superconnector deployment at `https://mcp.stratifysoftware.com`. Values never go in the repo; set them in Vercel. Use placeholders like `<generated>` in tickets and chat.

## Environment variables

Validation lives in `src/lib/env.ts`. In live mode a missing or malformed variable stops the app at first use, and the error names the variable and the rule, never the value.

| Name | Required in live mode | Format / rule | How to generate |
| --- | --- | --- | --- |
| `GOOGLE_MODE` | Yes (must be set explicitly on any Vercel deployment) | `live` or `mock`. `mock` is refused when `VERCEL_ENV=production`. | Set `live` for Production. |
| `STORE` | No | Must be `supabase` in live mode (the default there). `memory` is for mock mode only. | Leave unset or `supabase`. |
| `ENCRYPTION_KEY` | Yes | Base64 that decodes to exactly 32 bytes. Encrypts org client secrets and refresh and access tokens (AES-256-GCM). Not rotatable yet; see below. | `openssl rand -base64 32` |
| `SESSION_SECRET` | Yes | At least 32 characters. Signs the admin session cookie (12 hours) and derives the Google connect PKCE verifier. | `openssl rand -base64 48` |
| `CURSOR_SECRET` | Yes | At least 32 characters. Signs pagination cursors. | `openssl rand -base64 48` |
| `CRON_SECRET` | Yes | At least 32 characters. Bearer secret for `/api/cron/health`. Vercel sends it automatically to cron invocations. | `openssl rand -base64 48` |
| `ADMIN_EMAILS` | Yes | Comma-separated emails allowed to sign in (case-insensitive), at least one. | Your own addresses. |
| `ADMIN_GOOGLE_CLIENT_ID` | Yes | Client ID of the admin sign-in client. | From Google Cloud; see `docs/GOOGLE_CLOUD_SETUP.md`. |
| `ADMIN_GOOGLE_CLIENT_SECRET` | Yes | Its client secret. | Same. |
| `SUPABASE_URL` | Yes | Valid URL of the Supabase project. | Supabase dashboard → Project settings → API. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key. Server only. | Same. |
| `PUBLIC_BASE_URL` | Yes | An https origin with no path, query or trailing slash: `https://mcp.stratifysoftware.com`. | Fixed value. |

In mock mode all of these are optional. Missing `SESSION_SECRET` and `CURSOR_SECRET` get random per-process values, and a throwaway encryption key is used with the in-memory store.

Set variables for Production and for Preview. **Preview deployments must set `GOOGLE_MODE` explicitly**: the app refuses to start on Vercel (`VERCEL_ENV` set) or in a production build without it. Use `mock` on Preview unless you intend previews to touch live Google accounts, and in that case give Preview its own Supabase project and its own keys rather than the production ones.

## First deploy checklist

1. **Supabase.** Create a project. Apply `supabase/migrations/0001_init.sql` (SQL editor, or `supabase db push`). Confirm the eight tables exist and each has row level security enabled. Copy the project URL and the service role key.
2. **Vercel project.** Import the `stratifysebastian/superconnector` repo. Framework: Next.js. Node 22.
3. **Env vars.** Set every variable in the table above for Production (and Preview, per the note). Generate secrets with the commands shown; do not reuse a value across variables.
4. **Domain.** In the Vercel project add the domain `mcp.stratifysoftware.com`. At the DNS host create a `CNAME` record for `mcp` pointing to the target Vercel shows (typically `cname.vercel-dns.com`; use what the Vercel domain screen says). Wait until Vercel shows the domain as valid with a certificate.
5. **Cron.** `vercel.json` defines one job: `GET /api/cron/health` daily at 10:00 UTC (`0 10 * * *`). Vercel runs crons on the Production deployment only, and sends `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is set. After the first production deploy, check **Settings** → **Cron Jobs** lists it.
6. **Google setup.** Follow `docs/GOOGLE_CLOUD_SETUP.md`: the admin sign-in client first (so you can sign in), then one org client per Workspace org and a Connect for each account. Confirm each account shows **active** at `/connect`.
7. **Add the connector in Claude.** In Claude, go to Settings → Connectors → **Add custom connector** (label may differ). URL: `https://mcp.stratifysoftware.com/api/mcp`. Complete the sign-in in the browser with an allowlisted email and approve the consent screen.
8. **Verify.** Ask Claude to call `list_accounts`. Expect every connected account with label, email, priority, `status: "active"` and its products. Stratify is priority 1. Negative check: signing in with a non-allowlisted Google account is refused.
9. Run the health job once by hand (see "The daily job") and confirm every account reports `ok`.

## Operating procedures

### Reconnect an account that shows "Needs reconnect"

- **Symptoms.** `/connect` shows status **needs_reconnect**. `list_accounts` shows the same, with `reconnectUrl`. Tool results carry an `accountErrors` entry such as "PR1ME account disconnected — reconnect at https://mcp.stratifysoftware.com/connect". Other accounts keep working.
- **Cause.** Google answered `invalid_grant` to a refresh: password change, access revoked in the Google account or Workspace admin console, the app removed or blocked, or no refresh token stored. The token manager or the daily job flagged the account.
- **Steps.**
  1. Open `/connect` and sign in.
  2. On the account's row click **Reconnect**.
  3. Sign in with the same Google account and accept every permission.
  4. If you see "You signed in with a different Google account", repeat with the right one. If Google returns no refresh token, remove the app at <https://myaccount.google.com/connections> and reconnect.
  5. If it keeps failing, check the Workspace admin console (API controls) has not blocked the app; see `docs/GOOGLE_CLOUD_SETUP.md` step 6.
- **Verify.** The row shows **active**; `list_accounts` shows `status: "active"`; the next health run reports the account `ok`.

### Revoke all Claude access

- **Symptoms / when.** Claude's connector token may be exposed, or a device or client should lose access now.
- **Cause / effect.** The button revokes every OAuth token issued to MCP clients (Claude and any other client). Google accounts stay connected, stored Google tokens are not touched, and browser admin sessions are not ended.
- **Steps.**
  1. Open `/connect`, scroll to **Claude access**.
  2. Tick "I understand Claude will need to reconnect".
  3. Click **Revoke all Claude access**. The page reports how many tokens were revoked, and an `audit_log` entry (`revoke_all`) is written.
  4. To restore access, re-authorize the connector in Claude (it will run the sign-in again).
- **Verify.** An MCP call with an old token returns 401. `select at, tool, outcome, detail from audit_log where tool = 'revoke_all' order by at desc limit 1;` shows the entry.

### Sign out everywhere (rotate `SESSION_SECRET`)

- **Symptoms / when.** An admin browser session may be exposed, or you removed someone from `ADMIN_EMAILS` and want existing sessions gone. Sessions last 12 hours and are checked against the current allowlist.
- **Cause / effect.** The admin session cookie and the sign-in state are signed or sealed with keys derived from `SESSION_SECRET`. Changing it invalidates every session. It also derives the PKCE verifier for Google connect flows, so **any Google connect in progress fails** and must be restarted. MCP bearer tokens are unaffected; use "Revoke all Claude access" for those.
- **Steps.**
  1. Generate: `openssl rand -base64 48`.
  2. Replace `SESSION_SECRET` in Vercel (Production, and Preview if used).
  3. Redeploy (env changes apply to new deployments).
- **Verify.** Reload `/connect`: you are sent to `/signin`. Sign in again; the Connect buttons work.

### Rotate `CRON_SECRET`

- **Steps.**
  1. Generate: `openssl rand -base64 48`.
  2. Replace `CRON_SECRET` in Vercel Production and redeploy. Vercel sends the new value to the cron automatically.
  3. Update any copy you keep for manual runs.
- **Verify.** Run the job by hand with the new secret (below): 200. The old secret now returns 401.

### Rotate an org client secret

- **When.** The secret was exposed, or Google Cloud policy requires it.
- **Steps.**
  1. In Google Cloud (the org's project) open **Credentials**, open the OAuth client and click **Add secret** (label may differ). Copy the new secret.
  2. On `/connect`, in the org's card under **Org clients**, open the edit section, paste it into **Client secret**, and save. Leaving the field empty keeps the stored secret.
  3. Back in Google Cloud, disable and then delete the old secret.
- **Verify.** Run the daily job by hand: that org's accounts report `ok`. If they report `error`, the new secret is wrong; re-enter it.
- To rotate the **admin sign-in** client secret, do the same in Google Cloud, then change `ADMIN_GOOGLE_CLIENT_SECRET` in Vercel and redeploy.

### `ENCRYPTION_KEY` rotation is not supported yet

Do not change `ENCRYPTION_KEY` in place. Stored ciphertext carries a `v1:` prefix, but there is no re-encryption tool and only one key is ever used. If the value changes:

- Every stored secret becomes unreadable: org client secrets, refresh tokens and cached access tokens.
- Every account will fail on its next token use and be marked `needs_reconnect`, and each must be reconnected.
- Every org client secret must be re-entered on `/connect`.

Treat the key as permanent unless it is compromised. If it is compromised: set a new key in Vercel, redeploy, re-enter each org client secret, reconnect each account, and revoke old Google refresh tokens by removing the app in each Google account's third-party access page.

### Reading logs

Logs are one JSON object per line in the Vercel runtime logs (Project → Logs). Fields:

| Field | Meaning |
| --- | --- |
| `level` | `info`, `warn` or `error` |
| `ts` | ISO timestamp |
| `msg` | Short description, for example `health check account`, `account needs reconnect`, `oauth cleanup` |
| `tool` | Tool or job name, for example `list_accounts`, `health_check`, `cleanup` |
| `account` | Account label (not email) |
| `durationMs` | Call duration in milliseconds |
| `outcome` | `ok`, `error`, `needs_reconnect`, `degraded`, and similar |
| `status`, `kind` | HTTP status or error kind where relevant |

The logger drops values under keys that may carry secrets or content (names containing `token`, `secret`, `authorization`, `cookie`, `code`, `verifier`, `body`, `content`, `refresh`, `access`, `key`, `snippet`, `html`, `raw`, `attachment` and similar), replaces token-shaped strings (`ya29.…`, `1//…`, `Bearer …`, JWTs), and truncates long strings. Tokens, message bodies and file contents do not appear in logs; tests in `tests/lib/log.test.ts` enforce this. Filter by `account`, `tool` or `outcome: error` to find problems.

### The daily health and cleanup job

`GET /api/cron/health` runs once a day at 10:00 UTC. It force-refreshes the access token of every active account (accounts already flagged `needs_reconnect` are skipped and reported), flags any that fail with `invalid_grant`, then deletes expired OAuth codes, state and tokens and stale unused client registrations (older than 30 days).

Run it by hand:

```bash
curl -sS -H "Authorization: Bearer <CRON_SECRET>" https://mcp.stratifysoftware.com/api/cron/health
```

Responses: 200 with a summary, 401 for a missing or wrong secret, 503 if `CRON_SECRET` is not configured. Example summary:

```json
{
  "checkedAt": "2026-10-08T10:00:00.000Z",
  "results": [
    { "label": "stratify", "status": "ok" },
    { "label": "prime", "status": "needs_reconnect", "kind": "needs_reconnect" }
  ],
  "cleanup": { "codes": 0, "states": 2, "tokens": 5, "clients": 0 }
}
```

Each result is `ok`, `needs_reconnect` or `error`. `cleanup` is `{ "error": "failed" }` if housekeeping failed; health results are still returned. The summary holds labels and kinds only, no emails or tokens. Do not paste the real secret into a shell history you share; use a variable.

### What the `accountErrors` kinds mean

Tool results list problems per account alongside whatever succeeded, so a missing account is never silent.

| Kind | Meaning | What to do |
| --- | --- | --- |
| `needs_reconnect` | Google rejected the refresh token (`invalid_grant`). The account is flagged. | Reconnect at `/connect`. |
| `missing_scope` | The account has not granted a product the tool needs. | Reconnect and tick every permission. |
| `rate_limited` | Google returned 429 after 3 retries with backoff. | Retry shortly. |
| `timeout` | The account did not answer within the per-account limit (15 seconds by default); others returned. | Retry; check Google status if it persists. |
| `not_found` | The item does not exist in that account. | Check the id and the `account` argument. |
| `upstream_error` | Any other Google or network failure. | Check the logs by `account`; retry. |

## Security notes

Accepted risks from `docs/PLAN.md` (audit A1), documented and not fixed:

- **Refresh race (L3).** If two requests present the same refresh token at once, the winner keeps the new token pair that was issued.
- **Code reuse (L4).** Reusing an authorization code is rejected, but tokens already issued from that code are not revoked. Use "Revoke all Claude access" if you suspect this.
- **No AAD on ciphertext (L11).** Encrypted columns are not bound to their row, so someone with database write access could swap ciphertexts between rows. Exploiting this needs write access to Supabase, which only the service role has.
- **Allowlist keyed on email (L12).** Admin sign-in checks the verified Google email against `ADMIN_EMAILS`, not the Google account id. Keep the list short and remove departed addresses promptly.

Operational notes:

- **Rate limit on `/register` and `/token`.** The app does not rate limit these endpoints. It is a Vercel firewall setting: in the project open **Firewall** → **Configure** → add a rule (rate limit) for paths `/register` and `/token`, for example 20 requests per minute per IP, action Deny or Challenge (labels may differ). Dynamic client registrations are capped at 200 in the app and stale ones are purged daily.
- **Scopes are broad on purpose.** `gmail.modify` and `drive` permit sending and sharing. Safety rests on the server's endpoint policy, not on the scopes. Do not reuse these OAuth clients for anything else.
- **Secrets.** Never commit `.env*`. If a secret is pasted anywhere public, rotate it using the procedures above.
- **Headers.** The app sets `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer` and HSTS on all routes.
