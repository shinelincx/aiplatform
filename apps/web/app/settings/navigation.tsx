'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '../icons';
import { settingsPath, settingsViews } from '../workspace';

export function SettingsNavigation({ admin }: { admin: boolean }) {
  const pathname = usePathname();
  return <nav className="nav settings-nav" aria-label="设置导航">
    {settingsViews.filter(({ adminOnly }) => !adminOnly || admin).map(({ id, label, icon }) => {
      const href = settingsPath(id);
      return <Link key={id} href={href} className="quickbtn" aria-current={pathname === href ? 'page' : undefined}>
        <Icon name={icon} /><span>{label}</span>
      </Link>;
    })}
  </nav>;
}
