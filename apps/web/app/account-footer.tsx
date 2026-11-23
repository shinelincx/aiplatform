import type { Account } from '@ado/shared';
import Link from 'next/link';
import { logout } from './actions';
import { Icon } from './icons';
import { settingsHref } from './workspace';

export function AccountFooter({ account, inSettings = false }: { account: Account; inSettings?: boolean }) {
  return <footer className="system-account">
    <Link className="account" href={settingsHref} aria-current={inSettings ? 'location' : undefined}
      aria-label={`${account.name}，打开设置`} title="设置">
      <span className="account__avatar" aria-hidden="true">{Array.from(account.name).slice(0, 2).join('').toUpperCase()}</span>
      <div><strong>{account.name}</strong><small>{account.systemRole === 'admin' ? '管理员' : '普通账号'}</small></div>
      <Icon name="chevron" />
    </Link>
    <form action={logout}><button className="btn-ghost">退出</button></form>
  </footer>;
}
