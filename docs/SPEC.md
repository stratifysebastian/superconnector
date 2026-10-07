# Multi-Account Google Connector — Build Spec

Oct 7, 2026 · @Seb

## Purpose

Build one remote MCP server that gives Claude every Google integration Claude already offers (Gmail, Calendar, Drive, Docs, Sheets, Slides) across multiple Google accounts at once, with the account as a tool parameter.

The built-in Google connectors each bind to a single account. Seb runs separate companies on separate Google Workspace orgs, so his executive assistant agent sees only one account and misses meetings and mail in his briefs. This server fixes that without changing how the agent's existing gates (drafting, approvals) work.

Microsoft 365 follows the same pattern as the last phase. Google Chat is out of scope.

## Locked decisions

| Area | Decision |
| --- | --- |
| Hosting | Vercel (Next.js route handlers) + Supabase (Postgres) |
| Claude → server auth | Full OAuth 2.1 (authorization code + PKCE, dynamic client registration) |
| Google products | Gmail, Calendar, Drive, Docs, Sheets, Slides — parity with Claude's built-in Google connectors. No Chat |
| Accounts at launch | Stratify Workspace account, PR1ME Workspace account (separate orgs) |
| Account priority | Stratify first, then the rest in connection order |
| No account named | Reads fan out to every account; results merged, sorted by date (newest first), each item tagged by account |
| Duplicates | Same calendar event on several accounts shows once, carrying every account tag |
| Sending | Never. No tool sends, forwards or replies. Drafts only |
| Calendar writes | Create and update events with no guests. Never invites anyone |
| Excluded | Sharing, trash/delete, accept/decline events |
| Behaviour rule | Otherwise behave exactly like the built-in Google connectors; the agent's own gates handle approvals |
| Adding accounts | Via a hosted Connect page, no code change or redeploy |
| Build approach | Each slice built against mocks first, then wired to live accounts |
| Build order | Calendar → Gmail → Drive → Docs → Sheets → Slides → Microsoft 365 |
| Cutover | Built-in connectors stay connected until parity is confirmed |

## Architecture

One Next.js app on Vercel serves four things: the MCP endpoint, the OAuth 2.1 authorization server Claude signs in to, the Connect page for adding Google accounts, and the Google OAuth callback. Supabase holds the account registry and encrypted tokens.

1. **MCP endpoint** — `/api/mcp`, Streamable HTTP transport, using the official MCP TypeScript SDK. Every request carries a bearer token from the OAuth 2.1 server.
2. **OAuth 2.1 authorization server** — `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/authorize`, `/token`, `/register` (dynamic client registration). PKCE required. Only Seb can authorize: sign-in is restricted to an allowlist of his own Google identities.
3. **Connect page** — `/connect`, behind the same sign-in. Lists connected accounts with status, a Connect button per configured org, and a Reconnect button for any account needing it. Reorderable priority.
4. **Google OAuth callback** — `/api/google/callback`. Requests `access_type=offline` and `prompt=consent` so a refresh token is always issued, stores it encrypted, records the account.
5. **Provider adapter layer** — one adapter per Google product (calendar, gmail, drive, docs, sheets, slides). Each exposes typed functions that take an account and return normalized results. The MCP tools never call Google directly.
6. **Fan-out engine** — resolves the account argument, calls the adapter per account in parallel, merges, de-duplicates, sorts and tags results (see Account model).

**Data model (Supabase)**

- `google_org_clients` — one row per Workspace org: label, OAuth client ID, client secret (encrypted), Workspace domain.
- `accounts` — id, provider (`google` / `microsoft`), email, label (e.g. `stratify`, `prime`), org client id, priority, connected\_at, status (`active` / `needs_reconnect`), granted scopes.
- `account_tokens` — account id, refresh token (encrypted), access token + expiry (encrypted, cache only).
- `audit_log` — every write call: timestamp, tool, account, target id, outcome. No message bodies.

Encrypt secrets at the application layer (AES-256-GCM, key in a Vercel environment variable) or with Supabase Vault. Row Level Security on all tables; the app uses the service role server-side only. No tokens in logs, URLs or tool results.

## Account model and fan-out

Every tool takes an optional `account` argument: a label (`stratify`), an email, a list of either, or `all`. Omitted means `all` for reads.

**Resolution order.** Accounts are processed in priority order: Stratify first, then every other account in the order it was connected. Priority is editable on the Connect page.

**Reads with several accounts**

- Call each account in parallel, with a per-account timeout (default 15 s).
- Merge into one list sorted by the item's natural date, newest first: message date (Gmail), event start (Calendar), modified time (Drive, Docs, Sheets, Slides). Ties break by account priority.
- Every item carries `account` (label) and `accountEmail`.
- Calendar de-duplication: events sharing an `iCalUID` and start time collapse into one item with `accounts: ["stratify", "prime"]` and the per-account event ids kept in `sources` so later updates hit the right copy.
- Drive de-duplication: the same file id visible from several accounts collapses the same way.
- Paging: the response returns one opaque `nextCursor` that encodes each account's own page token. Page size applies to the merged list.
- Partial failure never hides itself. The result includes an `accountErrors` array (account, error kind, what to do) alongside whatever succeeded.

**Lookups by id** (get\_message, read\_file\_content, etc.) need the account the id belongs to. Fan-out results already carry it; if the caller omits it, try accounts in priority order and return the first hit.

**Writes** (create\_draft, create\_event, update\_file, etc.) need exactly one account. If omitted, fall back to the account of the item being acted on (the thread for a reply draft, the event for an update); otherwise return an error asking which account. Writes never fan out.

**New tool:** `list_accounts` — returns each account's label, email, priority, status and granted products, so the agent can see what is connected and what needs reconnecting.

## Tool surface

Tool names, arguments and return shapes mirror Claude's built-in Google connectors as of October 2026, plus the `account` argument and account tags. Before each phase, list the built-in connector's current tools and diff against this table; the built-ins change over time.

| Product | Included | Excluded |
| --- | --- | --- |
| Calendar | list\_calendars, list\_events, search\_events, get\_event, suggest\_time (free/busy across all accounts), create\_event, update\_event (both guest-free, see guardrails) | delete\_event, respond\_to\_event |
| Gmail | search\_threads, get\_thread, get\_message, list\_drafts, get\_draft, create\_draft (new or reply-in-thread), update\_draft, list\_labels, create\_label, update\_label, label/unlabel message and thread, update\_message\_labels, apply sensitive labels, mark/unmark spam | send\_message, reply, forward, trash/untrash, delete\_draft, delete\_label, create\_filter (pending decision) |
| Drive | search\_files, list\_recent\_files, get\_file\_metadata, read\_file\_content, download\_file\_content, get\_file\_permissions (read only), create\_file, copy\_file, update\_file | share\_file, trash\_file |
| Docs | read\_doc, update\_doc | — |
| Sheets | get\_spreadsheet, get\_values, update\_values, update\_formulas, insert\_dimension, update\_spreadsheet | — |
| Slides | read\_presentation, read\_slide\_page, read\_slide\_page\_thumbnail, update\_presentation | — |
| Server | list\_accounts | — |

Reply drafts use Gmail's draft API with the original `threadId` and `In-Reply-To` / `References` headers so the draft sits in the thread, ready for Seb to send himself.

## Write guardrails

Guardrails are enforced in the server, not left to the agent. Excluded tools are never registered, so Claude cannot see or call them. Some Google scopes technically allow more than we expose (gmail.compose can send), so the adapters must never call the excluded endpoints either; add a test that fails if any adapter references them.

**Calendar**

- `create_event`: reject any `attendees` field with a clear error. Always call the API with `sendUpdates=none`. Put intended participants in the description only.
- `update_event`: allowed only on events where Seb's account is the sole attendee (or there are no attendees). Reject updates to events with other guests, because any change would notify them. Never add attendees. Always `sendUpdates=none`.
- Google Calendar has no draft-invite feature; a guest-free event with participants listed in the description is the stand-in.

**Gmail**

- Drafts only. Draft creation never triggers a send. `update_draft` cannot change a draft into a sent message.

**Drive, Docs, Sheets, Slides**

- No permission changes of any kind. `create_file` and `copy_file` inherit default permissions only.
- No trash or delete.

**All writes**

- Exactly one account per write (see Account model).
- Logged to `audit_log`.

## Google Cloud setup and scopes

Use one Google Cloud project per Workspace org, each with its OAuth consent screen set to **Internal**. Internal apps skip Google's verification and annual security assessment, and their refresh tokens do not hit the 7-day expiry that External apps in Testing mode get. The trade-off: an Internal client only accepts users from its own org, which is why each org gets its own.

**Per-org setup (Seb, as super admin, once per org)**

1. Create a Google Cloud project inside the org.
2. Enable the Gmail, Calendar, Drive, Docs, Sheets and Slides APIs.
3. Configure the OAuth consent screen: audience Internal, app name, support email.
4. Create an OAuth client (Web application) with redirect URI `https://<server-domain>/api/google/callback`.
5. Add the client ID and secret to `google_org_clients` through an admin form on the Connect page (never in the repo).
6. In the Workspace admin console, confirm third-party API access is not restricted for this app.
7. Click Connect for that org and sign in with the account.

**Scopes**

| Product | Scope | Notes |
| --- | --- | --- |
| Identity | `openid`, `email` | Identify the account at connect time |
| Calendar | `https://www.googleapis.com/auth/calendar` | Calendars, events, free/busy |
| Gmail | `https://www.googleapis.com/auth/gmail.modify` | Read, labels, spam, drafts. Also permits sending; the server never calls send |
| Drive | `https://www.googleapis.com/auth/drive` | Read and edit existing files, not just ones the app created |
| Docs | `https://www.googleapis.com/auth/documents` |  |
| Sheets | `https://www.googleapis.com/auth/spreadsheets` |  |
| Slides | `https://www.googleapis.com/auth/presentations` |  |

Request scopes per phase with `include_granted_scopes=true`, so each phase adds its scopes with one reconnect per account, unless Seb chooses to grant everything up front (open question).

## Errors and token health

The failure that matters most is a silent one: an account drops out and the brief looks complete. Every failure must be named in the tool result.

- **Expired or revoked refresh token** (`invalid_grant`, e.g. password change or revocation): mark the account `needs_reconnect`, keep serving the other accounts, and add an `accountErrors` entry: "PR1ME account disconnected — reconnect at /connect". `list_accounts` shows the same status.
- **Missing scope** (product added in a later phase): return an error naming the product and the account, with a reconnect link.
- **Rate limits** (HTTP 429 / `rateLimitExceeded`): exponential backoff with jitter, max 3 retries, then an `accountErrors` entry.
- **Timeouts**: the slow account is reported in `accountErrors`; the others still return.
- **Guardrail rejection** (attendees on an event, update on a guest event): a plain-language error saying what was blocked and why.
- **Daily health check**: a Vercel cron job refreshes each account's access token once a day and marks failures `needs_reconnect`, so a dead token is caught before the morning brief runs.
- **Logging**: structured logs per call (tool, account, duration, outcome). No message bodies, file contents or tokens.

## Mocks and testing

Every phase is built and tested against mocks before it touches a live account.

- **Mock mode**: `GOOGLE_MODE=mock` swaps each adapter for a fixture-backed fake with the same interface. Fixtures live in `fixtures/<product>/` as JSON shaped like real Google API responses.
- **Fixtures cover two accounts** (`stratify`, `prime`) including: the same meeting on both calendars (same `iCalUID`), overlapping dates for merge ordering, multi-page results, one account returning `invalid_grant`, one returning 429, and one timing out.
- **Unit tests**: account resolution, priority order, merge sort, de-duplication, cursor encoding, every guardrail (attendees rejected, guest-event update rejected, `sendUpdates=none` always set).
- **Contract test**: no adapter imports or calls an excluded endpoint (send, forward, reply, trash, delete, share, respond).
- **MCP tests**: spin up the server in mock mode and exercise each tool through an MCP client, including the OAuth 2.1 flow.
- **Live verification** per phase, with Seb watching: read real data from both accounts, show it, and confirm it is right before the phase is called done.

## Build phases

Each phase ships only when its acceptance criteria pass in mock mode and then live with both accounts.

| Phase | Scope | Done when |
| --- | --- | --- |
| 0. Foundation | Next.js app, MCP endpoint, OAuth 2.1 server, Supabase schema, encryption, Connect page, `list_accounts`, mock framework, fan-out engine | Claude connects as a custom connector; both accounts connect; `list_accounts` shows both as active |
| 1. Calendar | All Calendar tools in the table, de-duplication, guest-free guardrails | Morning brief shows events from both accounts, shared meetings once with both tags; create\_event with attendees is rejected |
| 2. Gmail | All Gmail tools in the table, reply-in-thread drafts | Search with no account returns mail from both, merged by date; reply draft lands in the right thread of the right account |
| 3. Drive | Drive tools | Search and read across both accounts; no share or trash tool exists |
| 4. Docs | Docs tools | Read and edit a doc in each account |
| 5. Sheets | Sheets tools | Read and update values in each account |
| 6. Slides | Slides tools | Read and update a deck in each account |
| 7. Microsoft 365 | Same account model and guardrails for Outlook mail, calendar, OneDrive/SharePoint | Separate spec round before starting |

After phase 2, point the executive assistant agent at this connector for its briefs, keeping the built-in Google connectors connected as a fallback.

## Cutover and open questions

The built-in Google connectors are disconnected only after phases 1–6 pass live and the agent has run its briefs on this connector for at least a week without an unexplained gap.

**Open questions for Seb**

- [ ] Gmail filters: `create_filter` is in the built-in connector but creates a standing rule. Include it, or leave it out?
- [ ] Scopes: add them phase by phase (one reconnect per account per phase), or grant all six products up front?
- [ ] Calendar updates on events that already have other guests: block entirely (current spec), or allow edits that don't notify anyone, like a private note?
- [ ] Server domain: a subdomain such as `mcp.stratifysoftware.com`, or the default Vercel URL?
- [ ] Repo: new private repo under @stratifysebastian, and its name.
