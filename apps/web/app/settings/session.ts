import type { Account } from '@ado/shared';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { read } from '../api-client';
import { settingsPath } from '../workspace';

export const requireSettingsAccount = cache(async () => {
  const account = await read<Account>('/auth/session').catch(() => null);
  if (!account) redirect('/');
  return account;
});

export async function requireSettingsAdmin() {
  const account = await requireSettingsAccount();
  if (account.systemRole !== 'admin') redirect(`${settingsPath('account')}?issue=forbidden`);
}
