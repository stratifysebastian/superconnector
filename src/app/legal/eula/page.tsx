export const metadata = { title: 'Superconnector — End-user licence agreement' };

export default function Eula() {
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '2rem 1rem', lineHeight: 1.6 }}>
      <h1>End-user licence agreement</h1>
      <p>Last updated: 16 October 2026</p>
      <p>
        Superconnector is a private tool operated by Stratify Software Canada Inc. (&ldquo;Stratify&rdquo;) for its own
        internal use. It connects Stratify&rsquo;s own Google and QuickBooks Online accounts to Claude through the Model
        Context Protocol. It is not offered, sold or licensed to anyone else.
      </p>
      <h2>Who may use it</h2>
      <p>
        Only people Stratify has authorised may sign in. Access is limited to an allowlist of administrator accounts, and
        every connected Google or QuickBooks account must be connected by an administrator.
      </p>
      <h2>What it does</h2>
      <p>
        On an authorised user&rsquo;s request, Superconnector reads and updates data in the connected accounts using
        the access each account grants. A connection can be removed at any time from the Superconnector connect page or
        from the provider (Google account settings, or QuickBooks &ldquo;Connected apps&rdquo;).
      </p>
      <h2>No warranty</h2>
      <p>
        Superconnector is provided as is, without warranties of any kind. To the extent permitted by law, Stratify is not
        liable for any loss arising from its use.
      </p>
      <h2>Contact</h2>
      <p>Contact Stratify Software Canada Inc. through stratifysoftware.com.</p>
      <p>
        <a href="/legal/privacy">Privacy policy</a>
      </p>
    </main>
  );
}
