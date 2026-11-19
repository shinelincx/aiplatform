'use client';

import { useEffect, useRef, type ComponentProps } from 'react';
import { useFormStatus } from 'react-dom';

export function SubmitButton({ pendingLabel, children, disabled, ...props }: ComponentProps<'button'> & {
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  return <button {...props} disabled={disabled || pending}>
    <span aria-live="polite">{pending ? pendingLabel : children}</span>
  </button>;
}

export function ActionFeedback({ message, error }: { message: string; error?: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [message]);
  return <p ref={ref} tabIndex={-1} role={error ? 'alert' : 'status'}
    className={error ? 'feedback action-feedback' : 'action-feedback'}>{message}</p>;
}

export function TaskDetailFocus() {
  useEffect(() => {
    if (window.location.hash === '#task-detail') {
      document.getElementById('task-detail')?.focus();
    }
  }, []);
  return null;
}
