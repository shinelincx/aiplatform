'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useTransition } from 'react';

export function RefreshExecution({ intervalMs = 3000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}

export function RetrySection({ label, buttonLabel }: { label: string; buttonLabel?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <button type="button" className="secondary" aria-disabled={pending} aria-label={buttonLabel ? `刷新${label}` : undefined}
    onClick={() => {
      if (!pending) startTransition(() => router.refresh());
    }}>
    <span aria-live="polite">{pending ? (buttonLabel ? '刷新中…' : `正在重新加载${label}…`) : buttonLabel ?? `重新加载${label}`}</span>
  </button>;
}
