import type { Account } from '@ado/shared';
import { createUser } from '../../actions';
import { read } from '../../api-client';
import { ActionDialog } from '../../console-controls';
import { Icon } from '../../icons';
import { requireSettingsAdmin } from '../session';
import { SettingsScreen, type SettingsSearch } from '../screen';

export const metadata = { title: '账号管理 · ADO' };

export default async function Page({ searchParams }: { searchParams: SettingsSearch }) {
  await requireSettingsAdmin();
  const users = await read<Account[]>('/users') ?? [];
  return <SettingsScreen title="账号管理" searchParams={searchParams}>
    <section className="panel">
      <header className="panel__head">
        <h2 className="panel__title"><Icon name="shield" />账号列表 <em>{users.length}</em></h2>
        <ActionDialog title="创建账号" actionKey="accounts">
          <form action={createUser} className="fields">
            <label>名称<input name="name" maxLength={100} required /></label>
            <label>邮箱<input name="email" type="email" maxLength={255} required /></label>
            <label>初始密码<input name="password" type="password" minLength={12} maxLength={256} autoComplete="new-password" required /></label>
            <div className="form-actions"><button>创建账号</button></div>
          </form>
        </ActionDialog>
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
        </li>
      ))}</ul> : <p className="empty">暂无账号</p>}
    </section>
  </SettingsScreen>;
}
