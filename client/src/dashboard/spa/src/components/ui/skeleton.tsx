import * as React from 'react';
import { cn } from '../../lib/utils.js';

/**
 * Skeleton — minimal loading placeholder. Pulses a muted block until the
 * real content arrives. Replaces inline "Loading…" strings in panels that
 * fetch via react-query.
 */
const Skeleton = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  ),
);
Skeleton.displayName = 'Skeleton';

export { Skeleton };
