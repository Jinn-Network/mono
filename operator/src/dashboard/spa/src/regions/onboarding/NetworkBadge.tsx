import { Badge } from '../../components/ui/badge.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip.js';

import type { JSX } from 'react';

/**
 * Two-pill network indicator shown in the Onboarding header. The first pill
 * surfaces the active chain ("Testnet"), the second is a dimmed "Mainnet ·
 * soon" affordance with an explanatory tooltip. Pulled out of the parent
 * Onboarding region as part of the C.7 shadcn split.
 */
export function NetworkBadge({ chain }: { chain?: string }): JSX.Element {
  const isMainnet = chain === 'base';
  return (
    <div className="flex items-center gap-3">
      <Badge variant={!isMainnet ? 'outline' : 'secondary'}>Testnet</Badge>
      <TooltipProvider delayDuration={120}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Badge
                variant="secondary"
                className="border-dashed border-border opacity-60"
              >
                Mainnet · soon
              </Badge>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Mainnet support is coming. v1 supports testnet only.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
