export const metadata = { title: 'Superconnector — Privacy policy' };

export default function Privacy() {
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '2rem 1rem', lineHeight: 1.6 }}>
      <h1>Privacy policy</h1>
      <p>Last updated: 16 October 2026</p>
      <p>
        Superconnector is a private tool operated by Stratify Software Canada Inc. (&ldquo;Stratify&rdquo;) for its own
        internal use. This policy describes how it handles data from the Google and QuickBooks Online accounts that
        Stratify connects to it.
      </p>
      <h2>What it accesses</h2>
      <p>
        Only the accounts an administrator connects, and only the data needed to answer an authorised user&rsquo;s
        request: for example calendar events, email, files, and QuickBooks company, customer, product, invoice, estimate
        and report data.
      </p>
      <h2>What it stores</h2>
      <ul>
        <li>
          Connection details: the account&rsquo;s email or QuickBooks company id, and its OAuth tokens. Tokens and client
          secrets are encrypted (AES-256-GCM) before they are stored.
        </li>
        <li>
          An audit log of write actions: the tool name, the account, the item id and whether it succeeded. It never
          contains message bodies, file contents, amounts or customer details.
        </li>
      </ul>
      <p>
        Data read from Google or QuickBooks is passed to the authorised user&rsquo;s Claude session to answer the request
        and is not otherwise retained by Superconnector. Stored data is kept in a Supabase database in Canada
        (ca-central-1); the application runs on Vercel.
      </p>
      <h2>Sharing</h2>
      <p>
        Stratify does not sell or share this data. It is used only to provide Superconnector to Stratify&rsquo;s own
        authorised users.
      </p>
      <h2>Removal</h2>
      <p>
        Disconnecting an account (from the Superconnector connect page, from Google account settings, or from QuickBooks
        &ldquo;Connected apps&rdquo;) stops all access. Stored tokens can be deleted on request.
      </p>
      <h2>Contact</h2>
      <p>Contact Stratify Software Canada Inc. through stratifysoftware.com.</p>
      <p>
        <a href="/legal/eula">End-user licence agreement</a>
      </p>
    </main>
  );
}
