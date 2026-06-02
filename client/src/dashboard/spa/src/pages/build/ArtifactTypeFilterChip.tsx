import { Button } from '../../components/ui/button.js';

import type { JSX } from 'react';

export type ArtifactTypeFilter = 'plugin';

export interface ArtifactTypeFilterChipProps {
  value: ArtifactTypeFilter;
  onChange: (v: ArtifactTypeFilter) => void;
}

/**
 * Two-state filter for the /build registry. Renders Plug-ins (active by
 * default) and Harnesses (disabled placeholder). Built on shadcn `<Button>`
 * with `outline` / `ghost` variants and pill-rounded shape; the
 * `aria-pressed` semantics survive the migration so the existing tests and
 * screen readers keep working.
 */
export function ArtifactTypeFilterChip({ value, onChange }: ArtifactTypeFilterChipProps): JSX.Element {
  const pluginActive = value === 'plugin';
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant={pluginActive ? 'outline' : 'ghost'}
        size="sm"
        aria-pressed={pluginActive ? 'true' : 'false'}
        className="rounded-full"
        onClick={() => {
          if (!pluginActive) onChange('plugin');
        }}
      >
        Plug-ins
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled
        aria-pressed="false"
        className="rounded-full opacity-60"
      >
        Harnesses
        <span className="ml-1 border-l border-border pl-2 text-[9px] tracking-[0.14em] text-[var(--fg-dim)]">
          Coming soon
        </span>
      </Button>
    </div>
  );
}
