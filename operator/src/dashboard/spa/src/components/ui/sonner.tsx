import { Toaster as Sonner, type ToasterProps } from 'sonner';

import type { JSX } from 'react';

const Toaster = ({ ...props }: ToasterProps): JSX.Element => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-card group-[.toaster]:text-card-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg font-mono text-[12px]',
          description: 'group-[.toast]:text-[var(--fg-muted)]',
          actionButton:
            'group-[.toast]:bg-[var(--accent-sky)] group-[.toast]:text-[var(--bg-sunken)] font-mono text-[10px] uppercase tracking-[0.14em]',
          cancelButton:
            'group-[.toast]:bg-transparent group-[.toast]:text-[var(--fg-muted)] font-mono text-[10px] uppercase tracking-[0.14em]',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
