import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-mono text-[11px] uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--accent-sky)] text-[var(--bg-sunken)] hover:bg-[var(--accent-sky-hover)]',
        destructive:
          'border border-[var(--break-red)] bg-transparent text-[var(--break-red)] hover:bg-[var(--severity-blocking-bg)]',
        outline:
          'border border-[var(--accent-sky)] bg-transparent text-[var(--accent-sky)] hover:bg-[var(--bg-sunken)]',
        secondary:
          'border border-[var(--border)] bg-transparent text-[var(--fg-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--fg)]',
        ghost:
          'bg-transparent text-[var(--fg-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--fg)]',
        link: 'bg-transparent normal-case tracking-normal text-[var(--accent-sky)] hover:text-[var(--accent-sky-hover)] underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 px-3 py-1.5',
        sm: 'h-7 px-2.5 text-[10px]',
        lg: 'h-10 px-4 text-xs',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
