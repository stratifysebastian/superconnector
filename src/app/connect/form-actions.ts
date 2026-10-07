'use server';
// FormData adapters for the page's forms. They only call the plain actions.
import { renameAccount, reorderAccounts, saveOrgClient } from './actions';

export interface FormState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
}

const str = (d: FormData, k: string): string => {
  const v = d.get(k);
  return typeof v === 'string' ? v : '';
};

export async function moveAccountForm(data: FormData): Promise<void> {
  const direction = str(data, 'direction');
  await reorderAccounts({ accountId: str(data, 'accountId'), direction: direction === 'down' ? 'down' : 'up' });
}

export async function renameAccountForm(_prev: FormState, data: FormData): Promise<FormState> {
  const r = await renameAccount({ accountId: str(data, 'accountId'), label: str(data, 'label') });
  return r.ok ? { status: 'ok', message: 'Label saved.' } : { status: 'error', message: r.error };
}

export async function saveOrgClientForm(_prev: FormState, data: FormData): Promise<FormState> {
  const id = str(data, 'id');
  const r = await saveOrgClient({
    ...(id ? { id } : {}),
    label: str(data, 'label'),
    workspaceDomain: str(data, 'workspaceDomain'),
    clientId: str(data, 'clientId'),
    clientSecret: str(data, 'clientSecret'),
  });
  // Never return the submitted secret.
  return r.ok ? { status: 'ok', message: 'Org client saved.' } : { status: 'error', message: r.error };
}
