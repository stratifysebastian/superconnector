'use client';
import { useActionState } from 'react';
import { renameAccountForm, revokeAllForm, saveOrgClientForm, type FormState } from '@/app/connect/form-actions';
import styles from './connect.module.css';

const idle: FormState = { status: 'idle' };

function Message({ id, state }: { id: string; state: FormState }) {
  if (state.status === 'idle') return null;
  return (
    <p
      id={id}
      role={state.status === 'error' ? 'alert' : 'status'}
      className={state.status === 'error' ? styles.fieldError : styles.fieldOk}
    >
      {state.message}
    </p>
  );
}

export function RenameForm({ accountId, label }: { accountId: string; label: string }) {
  const [state, action, pending] = useActionState(renameAccountForm, idle);
  const inputId = `label-${accountId}`;
  return (
    <form action={action} className={styles.rename}>
      <input type="hidden" name="accountId" value={accountId} />
      <label htmlFor={inputId} className={styles.lbl}>Label<span className={styles.srOnly}>{` for ${label}`}</span></label>
      <div className={styles.row}>
        <input
          id={inputId}
          name="label"
          defaultValue={label}
          required
          maxLength={32}
          pattern="[a-z0-9][a-z0-9\-]{0,31}"
          title="Lowercase letters, digits and hyphens, starting with a letter or digit"
          autoComplete="off" spellCheck={false}
          aria-describedby={`${inputId}-msg`}
          aria-invalid={state.status === 'error' || undefined}
          className={styles.input}
        />
        <button type="submit" className={styles.btn} disabled={pending} aria-label={`Save label for ${label}`}>Save label</button>
      </div>
      <Message id={`${inputId}-msg`} state={state} />
    </form>
  );
}

export function OrgClientForm({
  id,
  defaults,
}: {
  id?: string;
  defaults: { label: string; workspaceDomain: string; clientId: string };
}) {
  const [state, action, pending] = useActionState(saveOrgClientForm, idle);
  const p = `org-${id ?? 'new'}`;
  return (
    <form action={action} className={styles.form}>
      {id ? <input type="hidden" name="id" value={id} /> : null}
      <label htmlFor={`${p}-label`} className={styles.lbl}>Label</label>
      <input id={`${p}-label`} name="label" defaultValue={defaults.label} required maxLength={32}
        pattern="[a-z0-9][a-z0-9\-]{0,31}" autoComplete="off" spellCheck={false} className={styles.input} />
      <label htmlFor={`${p}-domain`} className={styles.lbl}>Workspace domain</label>
      <input id={`${p}-domain`} name="workspaceDomain" defaultValue={defaults.workspaceDomain} required
        placeholder="example.com…" autoComplete="off" spellCheck={false} className={styles.input} />
      <label htmlFor={`${p}-cid`} className={styles.lbl}>Client ID</label>
      <input id={`${p}-cid`} name="clientId" defaultValue={defaults.clientId} required autoComplete="off" spellCheck={false}
        className={`${styles.input} ${styles.mono}`} />
      <label htmlFor={`${p}-secret`} className={styles.lbl}>Client secret</label>
      <input id={`${p}-secret`} name="clientSecret" type="password" autoComplete="off" spellCheck={false}
        required={!id} aria-describedby={`${p}-secret-help`} className={`${styles.input} ${styles.mono}`} />
      <p id={`${p}-secret-help`} className={styles.muted}>
        {id ? 'Leave blank to keep the stored secret. It is never displayed.' : 'Stored encrypted. It is never displayed again.'}
      </p>
      <button type="submit" className={styles.btnPrimary} disabled={pending}>{id ? 'Save changes' : 'Add org client'}</button>
      <Message id={`${p}-msg`} state={state} />
    </form>
  );
}

export function RevokeAllForm() {
  const [state, action, pending] = useActionState(revokeAllForm, idle);
  return (
    <form action={action} className={styles.form}>
      <label htmlFor="revoke-confirm" className={styles.check}>
        <input id="revoke-confirm" name="confirm" type="checkbox" required className={styles.checkbox} />
        <span>I understand Claude will need to reconnect</span>
      </label>
      <button type="submit" className={styles.btnDanger} disabled={pending}>Revoke all Claude access</button>
      <Message id="revoke-msg" state={state} />
    </form>
  );
}
