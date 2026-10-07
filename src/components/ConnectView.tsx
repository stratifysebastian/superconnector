import type { AccountView, ConnectData, Flash, OrgClientView } from '@/app/connect/logic';
import { moveAccountForm } from '@/app/connect/form-actions';
import { OrgClientForm, RenameForm } from './ConnectForms';
import styles from './connect.module.css';

const enc = encodeURIComponent;

function AccountRow({ a, last }: { a: AccountView; last: boolean }) {
  const needs = a.status === 'needs_reconnect';
  const reconnect = `/api/google/connect?org=${enc(a.orgClientId)}&account=${enc(a.id)}`;
  return (
    <tr>
      <th scope="row" className={styles.num}>{a.priority}</th>
      <td data-label="Label"><strong>{a.label}</strong></td>
      <td data-label="Email">{a.email}</td>
      <td data-label="Status">
        <span className={needs ? styles.badgeWarn : styles.badgeOk}>{needs ? 'Needs reconnect' : 'Active'}</span>
      </td>
      <td data-label="Products">
        <ul className={styles.chips}>
          {a.granted.map((p) => <li key={p}>{p}</li>)}
          {a.missing.map((p) => <li key={p} className={styles.missing}>{`${p} (missing)`}</li>)}
        </ul>
      </td>
      <td data-label="Actions">
        <div className={styles.actions}>
          <a href={reconnect} className={needs ? styles.btnPrimary : styles.btn}>Reconnect</a>
          <form action={moveAccountForm} className={styles.inline}>
            <input type="hidden" name="accountId" value={a.id} />
            <input type="hidden" name="direction" value="up" />
            <button type="submit" className={styles.btn} disabled={a.priority === 1} aria-label={`Move ${a.label} up`}>Move up</button>
          </form>
          <form action={moveAccountForm} className={styles.inline}>
            <input type="hidden" name="accountId" value={a.id} />
            <input type="hidden" name="direction" value="down" />
            <button type="submit" className={styles.btn} disabled={last} aria-label={`Move ${a.label} down`}>Move down</button>
          </form>
        </div>
        <RenameForm accountId={a.id} label={a.label} />
      </td>
    </tr>
  );
}

function OrgCard({ o }: { o: OrgClientView }) {
  return (
    <li className={styles.card}>
      <h3>{o.label}</h3>
      <dl className={styles.dl}>
        <dt>Workspace domain</dt>
        <dd>{o.workspaceDomain}</dd>
        <dt>Client ID</dt>
        <dd className={styles.mono}>{o.clientId}</dd>
        <dt>Client secret</dt>
        <dd>Stored encrypted (never shown)</dd>
      </dl>
      <a href={`/api/google/connect?org=${enc(o.id)}`} className={styles.btnPrimary}>Connect an account</a>
      <details className={styles.details}>
        <summary>{`Edit ${o.label}`}</summary>
        <OrgClientForm id={o.id} defaults={{ label: o.label, workspaceDomain: o.workspaceDomain, clientId: o.clientId }} />
      </details>
    </li>
  );
}

export function ConnectView({ data, flash }: { data: ConnectData; flash: Flash[] }) {
  const { accounts, orgClients } = data;
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>Connect accounts</h1>
        <div className={styles.who}>
          <span>{`Signed in as ${data.email}`}</span>
          <form method="post" action="/api/auth/signout" className={styles.inline}>
            <button type="submit" className={styles.btn}>Sign out</button>
          </form>
        </div>
      </header>

      <div role="status" aria-live="polite" className={styles.flashes}>
        {flash.map((f, i) => (
          <p key={i} className={styles[`flash_${f.kind}`]}>{f.text}</p>
        ))}
      </div>

      <section aria-labelledby="accounts-h">
        <h2 id="accounts-h">Connected accounts</h2>
        <p className={styles.muted}>Listed in priority order. Earlier accounts win when the same item exists in several.</p>
        {accounts.length === 0 ? (
          <p>No accounts connected yet. Add an org client below, then connect an account.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.srOnly}>Connected Google accounts in priority order</caption>
              <thead>
                <tr>
                  <th scope="col">Priority</th>
                  <th scope="col">Label</th>
                  <th scope="col">Email</th>
                  <th scope="col">Status</th>
                  <th scope="col">Products</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a, i) => <AccountRow key={a.id} a={a} last={i === accounts.length - 1} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="orgs-h">
        <h2 id="orgs-h">Org clients</h2>
        <p className={styles.muted}>
          In Google Cloud, create an OAuth client (Web application) and add this exact redirect URI.
        </p>
        <label htmlFor="redirect-uri" className={styles.lbl}>Redirect URI</label>
        <input id="redirect-uri" className={`${styles.input} ${styles.mono}`} readOnly value={data.redirectUri} />
        {orgClients.length === 0 ? (
          <p>No org clients yet.</p>
        ) : (
          <ul className={styles.cards}>
            {orgClients.map((o) => <OrgCard key={o.id} o={o} />)}
          </ul>
        )}
      </section>

      <section aria-labelledby="add-h">
        <h2 id="add-h">Add an org client</h2>
        <OrgClientForm defaults={{ label: '', workspaceDomain: '', clientId: '' }} />
      </section>
    </main>
  );
}
