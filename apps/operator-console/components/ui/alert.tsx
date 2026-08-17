import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const alertVariants = cva('rounded-[var(--radius-2)] border p-3 font-mono text-[13px]', {
  variants: {
    variant: {
      default: 'border-border bg-elevated',
      warning: 'border-wane/40 bg-wane/10 text-wane',
      destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      role="alert"
      data-slot="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('font-medium', className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('text-[12px] text-muted-foreground', className)} {...props} />;
}

export { Alert, AlertTitle, AlertDescription };
