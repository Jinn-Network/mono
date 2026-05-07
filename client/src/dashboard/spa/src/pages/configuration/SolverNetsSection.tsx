import { SectionCard } from '../../components/SectionCard.js';
import { RegistryCatalog } from '../operator-catalog/RegistryCatalog.js';
import type { NetCardConfig } from './NetCard.js';

/**
 * Operator > SolverNets section. Wraps the registry-driven discovery
 * surface (`RegistryCatalog`) inside the standard `SectionCard` shell so the
 * header / collapse / hash-deep-link behaviour stays consistent with the other
 * sections.
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` §12.
 *
 * History: previously rendered a hardcoded one-row "Prediction" catalog from
 * `/v1/setup/solvernets`. That hardcoded path is gone — operators now discover
 * launched SolverNets through the registry. Joined-SolverNets management
 * (per-manifestCid `roles` / `harness` / `model` / `plugins`) is implemented in
 * Task 21; for Task 20 this section only renders the discovery catalog.
 *
 * The legacy `configByName` / `onSaved` / `onRestartPending` props are retained
 * for the duration of the Task 21/22 migration so the predecessor
 * `Configuration.tsx` keeps compiling without churn. They are not consumed
 * here — the operator's joined-roles config will be plumbed through
 * `RegistryCatalog`'s join CTA in Task 21, and Task 22 drops the legacy
 * solver-nets schema entirely.
 */

export interface SolverNetsSectionProps {
  /** @deprecated — drained to nothing in Task 22. Retained for compat. */
  configByName?: Record<
    string,
    Partial<NetCardConfig> & { role?: 'solving' | 'evaluating' }
  >;
  /** @deprecated — kept for prop-compat; no-op in Task 20. */
  onSaved?: () => void;
  /** @deprecated — kept for prop-compat; no-op in Task 20. */
  onRestartPending?: () => void;
  defaultExpanded?: boolean;
}

export function SolverNetsSection({
  defaultExpanded = true,
}: SolverNetsSectionProps = {}): JSX.Element {
  return (
    <SectionCard
      title="SolverNets"
      summary="Discover launched SolverNets and join one to participate."
      defaultExpanded={defaultExpanded}
    >
      <RegistryCatalog />
    </SectionCard>
  );
}
