import type { Account } from '@ado/shared';
import { read } from '../../api-client';
import { Icon } from '../../icons';
import { requireSettingsAdmin } from '../session';
import { SettingsScreen, type SettingsSearch } from '../screen';
import { AccountDialog } from './account-dialog';

export const metadata = { title: '账号管理 · ADO' };

export default async function Page({ searchParams }: { searchParams: SettingsSearch }) {
  const actor = await requireSettingsAdmin();
  const users = await read<Account[]>('/users') ?? [];
  return <SettingsScreen title="账号管理" searchParams={searchParams}>
    <section className="panel">
      <header className="panel__head">
        <h2 className="panel__title"><Icon name="shield" />账号列表 <em>{users.length}</em></h2>
        <AccountDialog operation="create" />
      </header>
      {users.length ? <ul className="system-list">{users.map((user) => (
        <li className="system-row" key={user.id}>
          <span className="member-name"><strong>{user.name}</strong><small>{user.email}</small></span>
          <span className="module-tags">
            <span className="module-tag">{user.systemRole === 'admin' ? '管理员' : '普通账号'}</span>
            <span className="module-tag" data-tone={user.status === 'active' ? 'mint' : 'rose'}>
              {user.status === 'active' ? '启用' : '停用'}
            </span>
          </span>
          <div className="page-actions">
            <AccountDialog operation="edit" account={user} isSelf={user.id === actor.id} />
            {user.status === 'active' && user.id !== actor.id && <AccountDialog operation="disable" account={user} />}
          </div>
        </li>
      ))}</ul> : <p className="empty">暂无账号</p>}
    </section>
  </SettingsScreen>;
}
