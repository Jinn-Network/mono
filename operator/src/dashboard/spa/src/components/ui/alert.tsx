import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

const alertVariants = cva(
  'relative w-full border-l-2 px-4 py-2 font-mono text-[12px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-3 [&>svg+div]:translate-y-[-3px]',
  {
    variants: {
      variant: {
        default: 'border-[var(--severity-info-fg)] bg-transparent text-foreground',
        info: 'border-[var(--severity-info-fg)] bg-transparent text-foreground',
        warning:
          'border-[var(--severity-warning-fg)] bg-[var(--severity-warning-bg)] text-foreground',
        blocking:
          'border-[var(--severity-blocking-fg)] bg-[var(--severity-blocking-bg)] text-foreground',
        success: 'border-[var(--vow-green)] bg-transparent text-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
));
Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5
      ref={ref}
      className={cn('mb-0.5 font-mono text-[11px] uppercase tracking-[0.14em]', className)}
      {...props}
    />
  ),
);
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-[12px] [&_p]:leading-relaxed', className)} {...props} />
  ),
);
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription, alertVariants };
