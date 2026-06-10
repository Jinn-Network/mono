import { type JSX } from 'react';
import { cn } from '../../lib/utils.js';

/**
 * FLAGGED SNOWFLAKE (frontend rules §shadcn). A 3-state tier glyph for the
 * harness availability model (spec §2.9): protocol-available ·
 * node-build-supported · installed-on-machine. No shadcn primitive expresses a
 * 3-state indicator; this is the smallest possible surface (three spans,
 * currentColor, no new design tokens). If shadcn later ships an equivalent,
 * migrate to it.
 *
 * Maintenance: owned by the onboarding region; depends only on `cn` + existing
 * CSS vars. Migration path back to shadcn = swap the spans for the primitive.
 */
export function TierDots({
  protocol,
  node,
  machine,
}: {
  protocol: boolean;
  node: boolean;
  machine: boolean;
}): JSX.Element {
  const tiers: Array<{ id: string; active: boolean }> = [
    { id: 'protocol', active: protocol },
    { id: 'node', active: node },
    { id: 'machine', active: machine },
  ];
  return (
    <span data-testid="tier-dots" className="inline-flex items-center gap-1" aria-hidden>
      {tiers.map((t) => (
        <span
          key={t.id}
          data-tier={t.id}
          data-active={t.active ? 'true' : 'false'}
          className={cn(
            'size-1.5 rounded-full border border-current transition-colors',
            t.active
              ? 'bg-current text-[var(--accent-sky)]'
              : 'bg-transparent text-[var(--fg-dim)]',
          )}
        />
      ))}
    </span>
  );
}
