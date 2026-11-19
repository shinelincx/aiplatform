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

export function RetrySection({ label }: { label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <button type="button" className="secondary" aria-disabled={pending}
    onClick={() => {
      if (!pending) startTransition(() => router.refresh());
    }}>
    <span aria-live="polite">{pending ? `正在重新加载${label}…` : `重新加载${label}`}</span>
  </button>;
}
