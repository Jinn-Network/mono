import { Compass } from 'lucide-react';
import { RegistryCatalog } from '../operator-catalog/RegistryCatalog.js';

import type { JSX } from 'react';

/**
 * /operator/registry — SolverNet registry browse + join (§2.5).
 */
export function RegistryTab(): JSX.Element {
  return (
    <div data-testid="registry-tab" className="flex flex-col gap-3">
      <span className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        <Compass className="h-3.5 w-3.5" aria-hidden="true" />
        Discover
      </span>
      <RegistryCatalog />
    </div>
  );
}
