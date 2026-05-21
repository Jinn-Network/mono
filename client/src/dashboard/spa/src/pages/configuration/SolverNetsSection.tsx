import { useEffect, useRef } from 'react';
import { SectionCard } from '../../components/SectionCard.js';
import { RegistryCatalog } from '../operator-catalog/RegistryCatalog.js';
import type { NetCardConfig } from './NetCard.js';

/**
 * Operator > SolverNets section — DISCOVER block only.
 *
 * The JOINED block has been extracted to
 * `pages/operator/MembershipsTab.tsx` (§2.4, Task 5.3).
 * This component now wraps only the RegistryCatalog and will be
 * deleted entirely in Task 5.4 once RegistryTab is extracted.
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` §12
 *
 * Hash deep-link: #solvernets still scrolls/focuses the section anchor.
 */

export interface SolverNetsSectionProps {
  /** @deprecated — drained to nothing in Task 22. Retained for compat. */
  configByName?: Record<
    string,
    Partial<NetCardConfig> & { role?: 'solving' | 'evaluating' }
  >;
  /** @deprecated — kept for prop-compat; no-op today. */
  onSaved?: () => void;
  /** @deprecated — no-op after JOINED block extraction. */
  onRestartPending?: () => void;
  defaultExpanded?: boolean;
  /** @deprecated — no-op after JOINED block extraction. */
  joinedHashFragment?: string;
}

export function SolverNetsSection({
  defaultExpanded = true,
}: SolverNetsSectionProps = {}): JSX.Element {
  const sectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const focusSection = (): void => {
      if (!defaultExpanded) return;
      if (window.location.hash !== '#solvernets') return;
      sectionRef.current?.scrollIntoView({ block: 'start' });
      sectionRef.current?.focus({ preventScroll: true });
    };
    focusSection();
    window.addEventListener('hashchange', focusSection);
    return () => window.removeEventListener('hashchange', focusSection);
  }, [defaultExpanded]);

  return (
    <div id="solvernets" ref={sectionRef} tabIndex={-1}>
      <SectionCard
        title="SolverNets"
        summary="Discover and join SolverNets."
        defaultExpanded={defaultExpanded}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <section
            data-testid="solvernets-discover-block"
            style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
          >
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                fontWeight: 500,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--fg-muted)',
              }}
            >
              Discover
            </span>
            <RegistryCatalog />
          </section>
        </div>
      </SectionCard>
    </div>
  );
}
