import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';

import type { JSX } from 'react';

export type PhaseStatus = 'done' | 'active' | 'queued' | 'error';

/**
 * Status pill rendered at the right edge of each Onboarding PhaseRow.
 * Maps the four phase states to shadcn `<Badge>` variants and a small lucide
 * icon (or pulse dot for the active state). Pulled out of the parent
 * Onboarding region as part of the C.7 shadcn split.
 */
export function PhaseStatusTag({ status }: { status: PhaseStatus }): JSX.Element {
  if (status === 'done') {
    return (
      <Badge variant="success" className="gap-1.5">
        <CheckCircle2 className="h-3 w-3" />
        Done
      </Badge>
    );
  }
  if (status === 'error') {
    return (
      <Badge variant="destructive" className="gap-1.5">
        <AlertTriangle className="h-3 w-3" />
        Failed
      </Badge>
    );
  }
  if (status === 'active') {
    return (
      <Badge variant="warning" className="gap-2">
        <span
          aria-hidden="true"
          className="jinn-anim-pulse h-1.5 w-1.5 rounded-full bg-[var(--accent-gold)]"
        />
        Active
      </Badge>
    );
  }
  return <Badge variant="secondary">Queued</Badge>;
}
