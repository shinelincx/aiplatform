import { Suspense, type ReactNode } from 'react';
import type { ReadIssue } from './api-client';
import { RetrySection } from './refresh-execution';

const messages: Record<ReadIssue, string> = {
  expired: '会话已失效，请重新登录后重试。',
  forbidden: '当前账号没有读取权限，请确认项目访问权限。',
  unavailable: '服务暂时无法提供数据，请稍后重试。',
};

export function SectionReadError({ label, issue }: { label: string; issue: ReadIssue }) {
  return <div>
    <p className="feedback" role="alert">无法读取{label}。{messages[issue]}</p>
    <RetrySection label={label} />
  </div>;
}

export function DataPanel({ id, headingId, title, children }: {
  id?: string;
  headingId: string;
  title: string;
  children: ReactNode;
}) {
  return <section id={id} className="panel" aria-labelledby={headingId}>
    <h2 id={headingId}>{title}</h2>
    <Suspense fallback={<p role="status">正在加载{title}…</p>}>
      {children}
    </Suspense>
  </section>;
}
