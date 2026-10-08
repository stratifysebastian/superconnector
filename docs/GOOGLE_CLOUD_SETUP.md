# Google Cloud setup

Do this once per Google Workspace org (Stratify, PR1ME), signed in as a super admin of that org. Then do the "Admin sign-in client" section once.

Each org gets its own Google Cloud project and its own OAuth client. The consent screen must be **Internal**: Internal apps skip Google's verification and security assessment, and their refresh tokens do not expire after 7 days. The trade-off is that an Internal client accepts only users from its own org, which is why each org needs its own client.

Console labels change often. Where a label below is uncertain it says "(label may differ)"; follow the intent.

Before you start, have the server domain ready: `https://mcp.stratifysoftware.com`.

## Per-org steps

### 1. Create a Google Cloud project inside the org

1. Go to <https://console.cloud.google.com> and sign in with the org's super admin account.
2. Open the project picker at the top left and click **New project**.
3. Project name: for example `superconnector-stratify`. Under **Organization** pick the Workspace org (not "No organization"); Internal consent screens need the project to belong to the org. Click **Create**.
4. Select the new project in the project picker.

### 2. Enable the six APIs

Open **APIs & Services** → **Library** (label may differ). Search for each API by its exact name, open it and click **Enable**:

1. Gmail API
2. Google Calendar API
3. Google Drive API
4. Google Docs API
5. Google Sheets API
6. Google Slides API

Check **APIs & Services** → **Enabled APIs & services** lists all six.

### 3. Configure the OAuth consent screen (Internal)

1. Open **APIs & Services** → **OAuth consent screen**. In newer consoles this is under **Google Auth Platform** → **Branding / Audience / Data Access** (label may differ). Click **Get started** if prompted.
2. App name: for example `Superconnector`. User support email: your own address.
3. Audience (user type): choose **Internal**. If only **External** is offered, the project is not inside the org; go back to step 1.
4. Developer contact information: your email. Save.
5. You do not need to add scopes here: the app requests them at connect time, and Internal apps need no verification. If you want them listed under **Data access** (label may differ), they are the scopes in the table below.

### 4. Create the OAuth client (Web application)

1. Open **APIs & Services** → **Credentials** (or **Google Auth Platform** → **Clients**; label may differ).
2. Click **Create credentials** → **OAuth client ID** (or **Create client**).
3. Application type: **Web application**.
4. Name: for example `superconnector-stratify`.
5. Leave **Authorized JavaScript origins** empty.
6. Under **Authorized redirect URIs** click **Add URI** and enter exactly:

   ```
   https://mcp.stratifysoftware.com/api/google/callback
   ```

   No trailing slash. Any difference makes Google reject the connect with `redirect_uri_mismatch`.
7. Click **Create**. Keep the dialog open, or copy the **Client ID** and **Client secret** to a password manager. Never paste them into the repo, a ticket or a chat.

### 5. Add the client to Superconnector (never in the repo)

1. Open `https://mcp.stratifysoftware.com/connect` and sign in with an allowlisted admin email (see "Admin sign-in client" below).
2. Under **Add an org client** fill in:
   - **Label**: `stratify` (or `prime`). Lowercase letters, digits and `-`, 1 to 32 characters. The first account of this org takes this label, and an account labelled `stratify` is placed first in priority.
   - **Workspace domain**: the org's primary domain, for example `stratifysoftware.com`. The connect flow refuses any account whose Google `hd` claim differs.
   - **Client ID** and **Client secret**: from step 4. The secret is write-only; it is never shown again.
3. Submit. The org appears under **Org clients** with a **Connect an account** button.

### 6. Workspace admin console: allow the app

1. Go to <https://admin.google.com> as a super admin of the same org.
2. Open **Security** → **Access and data control** → **API controls** (label may differ).
3. Check whether third-party API access is restricted. If **Restrict access to Google services** or "Block all third-party API access" style settings are on, open **Manage third-party app access** (label may differ).
4. Click **Add app** → **OAuth App Name Or Client ID**, paste the Client ID from step 4, select the app, and set its access to **Trusted** (label may differ; "Trusted: can access all Google services" or equivalent). If third-party access is not restricted for the org, there is nothing to change; confirm the app is not listed as **Blocked**.

### 7. Connect the account

1. On `/connect`, click **Connect an account** on the org card.
2. Sign in with the Workspace account for that org and accept the permissions. Tick every box: all six products are requested up front, and a partly granted account shows a warning and is listed with missing products.
3. You return to `/connect` with a "Connected account" message. The account shows status **active** and its products.
4. Repeat for the next org. Priority puts the `stratify` account first; reorder with **Move up** and **Move down** if needed.

If Google returns no refresh token, remove the app under the Google account's third-party access (<https://myaccount.google.com/connections>), then connect again.

## Scopes requested

All six products are granted up front (decision recorded in `docs/PLAN.md` §8). The strings come from `src/core/products.ts`. The connect URL also sends `access_type=offline`, `prompt=consent` and `include_granted_scopes=true`.

| Product | Scope |
| --- | --- |
| Identity | `openid`, `email` |
| Calendar | `https://www.googleapis.com/auth/calendar` |
| Gmail | `https://www.googleapis.com/auth/gmail.modify` |
| Drive | `https://www.googleapis.com/auth/drive` |
| Docs | `https://www.googleapis.com/auth/documents` |
| Sheets | `https://www.googleapis.com/auth/spreadsheets` |
| Slides | `https://www.googleapis.com/auth/presentations` |

Some of these scopes technically allow more than the server exposes (`gmail.modify` can send, `drive` can share and delete). The server never calls those endpoints; see "How guardrails are enforced" in `README.md`.

## Admin sign-in client

`/signin` protects `/connect` and `/authorize`. It needs its own Google OAuth client, because org clients are entered through `/connect`, which already needs a sign-in. This bootstrap client is separate from the org clients and lives only in Vercel environment variables.

It can be a second OAuth client in the Stratify project (Internal is fine if every admin signs in with a Stratify identity).

1. In the Stratify project open **Credentials** and click **Create credentials** → **OAuth client ID** → **Web application**. Name: `superconnector-admin-signin`.
2. Authorized redirect URI, exactly:

   ```
   https://mcp.stratifysoftware.com/api/auth/callback
   ```

   For local development with a real client also add `http://localhost:3000/api/auth/callback`.
3. Scopes: the sign-in requests only `openid email`. Nothing else is needed.
4. Set the client ID and secret in Vercel (Production and Preview) as `ADMIN_GOOGLE_CLIENT_ID` and `ADMIN_GOOGLE_CLIENT_SECRET`. Do not enter them anywhere else, and never in the repo.
5. Set `ADMIN_EMAILS` to a comma-separated list of the emails allowed to sign in. Only these emails get a session; anyone else is refused after Google sign-in. Because the client is Internal, listed emails must belong to the Stratify org.

See `docs/RUNBOOK.md` for the full variable list and for rotating these values.
