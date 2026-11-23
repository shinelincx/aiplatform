import Link from 'next/link';
import type { ReactNode } from 'react';
import { AccountFooter } from '../account-footer';
import { BrandMark, Icon, IconSprite } from '../icons';
import { ThemeToggle } from '../theme';
import { SettingsNavigation } from './navigation';
import { requireSettingsAccount } from './session';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const account = await requireSettingsAccount();
  return <>
    <IconSprite />
    <div className="shell settings-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="返回工作台">
          <BrandMark /><span className="brand__text"><strong>ADO</strong><small>CONTROL PLANE</small></span>
        </Link>
        <div className="topbar__right"><ThemeToggle /></div>
      </header>
      <aside className="rail" aria-label="设置">
        <Link className="quickbtn settings-back" href="/"><Icon name="grid" /><span>返回工作台</span></Link>
        <div><p className="rail__label settings-nav__label">设置</p>
          <SettingsNavigation admin={account.systemRole === 'admin'} />
        </div>
      </aside>
      <main className="main" id="workspace">{children}</main>
      <AccountFooter account={account} inSettings />
    </div>
  </>;
}
