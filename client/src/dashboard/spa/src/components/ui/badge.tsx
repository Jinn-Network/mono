import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

import type { JSX } from 'react';

const badgeVariants = cva(
  'inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-[var(--accent-sky)] text-[var(--bg-sunken)]',
        secondary: 'border-transparent bg-[var(--bg-sunken)] text-[var(--fg-muted)]',
        destructive: 'border-[var(--severity-blocking-border)] bg-[var(--severity-blocking-bg)] text-[var(--severity-blocking-fg)]',
        warning: 'border-[var(--severity-warning-border)] bg-[var(--severity-warning-bg)] text-[var(--severity-warning-fg)]',
        success: 'border-[var(--severity-success-border)] bg-[var(--severity-success-bg)] text-[var(--severity-success-fg)]',
        outline: 'border-[var(--border)] bg-transparent text-[var(--fg)]',
        pill: 'rounded-full border-[var(--wane)] bg-transparent text-[var(--wane)] normal-case tracking-[0.12em] px-1.5',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
