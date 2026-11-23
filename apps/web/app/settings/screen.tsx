import type { ReactNode } from 'react';
import { issues, notices } from '../feedback';

export type SettingsSearch = Promise<{ issue?: string; notice?: string }>;

export async function SettingsScreen({ title, searchParams, children }: {
  title: string; searchParams: SettingsSearch; children: ReactNode;
}) {
  const { issue, notice } = await searchParams;
  return <section className="page system-settings" aria-labelledby="settings-heading">
    <header className="page__head">
      <div><p className="eyebrow">设置</p><h1 id="settings-heading">{title}</h1></div>
    </header>
    {issue && Object.hasOwn(issues, issue) && <p role="alert" className="feedback workspace-feedback">{issues[issue]}</p>}
    {notice && Object.hasOwn(notices, notice) && <p role="status" className="notice workspace-feedback">{notices[notice]}</p>}
    {children}
  </section>;
}
