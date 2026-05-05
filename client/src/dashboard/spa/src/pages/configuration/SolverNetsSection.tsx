import { useQuery } from '@tanstack/react-query';
import { SectionCard } from '../../components/SectionCard.js';
import { api } from '../../api/client.js';
import type { SolverNetCatalogEntry, SolverNetsCatalogResponse } from '../../api/types.js';
import { NetCard, type NetCardConfig } from './NetCard.js';

const STATE_RANK: Record<string, number> = { live: 0, available: 1, coming_soon: 2 };

/**
 * The bootstrap response can return per-SolverNet config that's missing
 * any combination of fields (enabled, role, harness, model, plugins) —
 * older configs predate role, third-party configs may omit model, etc.
 * Merge into a fully-populated NetCardConfig so the card renders sensibly
 * even on partially-shaped input.
 */
function resolveConfig(
  catalog: SolverNetCatalogEntry,
  stored: Partial<NetCardConfig> | undefined,
): NetCardConfig {
  return {
    enabled: stored?.enabled ?? false,
    role: stored?.role ?? (catalog.supportedRoles[0] ?? 'solving'),
    harness: stored?.harness ?? (catalog.compatibleHarnesses[0]?.name ?? ''),
    model: stored?.model ?? 'claude-haiku-4-5-20251001',
    modelExplicit: stored?.model !== undefined,
    plugins: stored?.plugins ?? [],
  };
}

export interface SolverNetsSectionProps {
  /** Stored per-net config from /v1/bootstrap. May be partially-shaped;
   *  resolveConfig fills missing fields with catalog-derived defaults. */
  configByName: Record<string, Partial<NetCardConfig>>;
  onSaved: () => void;
  onRestartPending: () => void;
  defaultExpanded?: boolean;
}

export function SolverNetsSection({
  configByName,
  onSaved,
  onRestartPending,
  defaultExpanded = true,
}: SolverNetsSectionProps): JSX.Element {
  const { data, isLoading } = useQuery<SolverNetsCatalogResponse>({
    queryKey: ['solvernets-catalog'],
    queryFn: () => api.getSolverNets(),
    staleTime: 60_000,
  });

  const nets = (data?.nets ?? []).slice().sort((a, b) => (STATE_RANK[a.state] ?? 99) - (STATE_RANK[b.state] ?? 99));
  const enabledCount = nets.filter((n) => configByName[n.name]?.enabled).length;
  const summary = isLoading
    ? 'Loading catalog…'
    : `${nets.length} available · ${enabledCount} enabled · pick what your node participates in`;

  return (
    <SectionCard
      title="SolverNets"
      summary={summary}
      defaultExpanded={defaultExpanded}
      metaChip={enabledCount > 0 ? { label: `${enabledCount} live`, tone: 'live' } : undefined}
    >
      {nets.map((catalog) => (
        <NetCard
          key={catalog.name}
          catalog={catalog}
          config={resolveConfig(catalog, configByName[catalog.name])}
          onSaved={onSaved}
          onRestartPending={onRestartPending}
        />
      ))}
    </SectionCard>
  );
}
