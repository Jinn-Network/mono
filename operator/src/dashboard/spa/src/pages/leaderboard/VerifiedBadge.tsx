import { Badge } from '../../components/ui/badge.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip.js';

import type { JSX } from 'react';

/**
 * Verified-status indicator for the frozen-mode leaderboard.
 *
 * `verified === true` → success Badge ("verified") with a tooltip explaining
 * that the source bundle + implStateDir CID are published and the codeDigest
 * is independently verifiable.
 *
 * `verified === false` → outline Badge ("unverified") with a tooltip noting
 * operator-claim-only provenance.
 *
 * `verified === null` → not rendered.
 */
export function VerifiedBadge({ verified }: { verified: boolean | null }): JSX.Element | null {
  if (verified === null) return null;
  const label = verified ? 'verified' : 'unverified';
  const tip = verified
    ? 'Source bundle + implStateDir CID published; codeDigest independently verifiable'
    : 'Operator-claim only; codeDigest not independently verifiable';
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant={verified ? 'success' : 'outline'}
            tabIndex={0}
            className="cursor-help normal-case tracking-[0.12em]"
          >
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
