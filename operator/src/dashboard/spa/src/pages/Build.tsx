import { useQuery } from '@tanstack/react-query';
import { useState, type JSX } from 'react';
import { api } from '../api/client.js';
import type { BootstrapState } from '../../../../api/contract/index.js';
import { Separator } from '../components/ui/separator.js';
import { IntroCard } from './build/IntroCard.js';
import { ShapeCatalogue } from './build/ShapeCatalogue.js';
import { PublishedPluginsPanel } from './build/PublishedPluginsPanel.js';
import { MyArtifactsPanel } from './build/MyArtifactsPanel.js';
import { ArtifactTypeFilterChip, type ArtifactTypeFilter } from './build/ArtifactTypeFilterChip.js';

/**
 * /build — the visible builder front door.
 *
 * Anchored on the SWE-rebench v2 SolverNet for v0; the published-plug-ins
 * panel filters by `swe-rebench-v2.v1` by default. The intro card content
 * is sourced live from `operator/docs/build/quickstart.md`. The shape
 * catalogue is generated from `SolverPluginManifest` via a hand-curated
 * descriptor with a snapshot/type-guard test pair keeping it in sync.
 *
 * Spec: docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md §6.6.
 */
const DEFAULT_SOLVER_TYPE = 'swe-rebench-v2.v1';

export function BuildPage(): JSX.Element {
  const { data: bootstrap } = useQuery<BootstrapState>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
    refetchInterval: 5_000,
  });
  const [artifactType, setArtifactType] = useState<ArtifactTypeFilter>('plugin');

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6 px-6 pb-12 pt-8">
      <header className="flex flex-col gap-2 pb-2">
        {/* Single Gold-as-Hint emphasis on this surface — the page eyebrow.
            The page-level H1 ("Build a plug-in") is rendered by IntroCard
            from the quickstart markdown; we don't repeat it here so there
            is exactly one H1 on the page. */}
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--accent-gold)]">
          Build · Plug-ins
        </span>
        <p className="m-0 max-w-[64ch] font-mono text-[14px] leading-[1.7] text-muted-foreground">
          Scaffold a SolverPlugin, publish it to npm and IPFS, watch it appear
          in the registry under your builder identity. Anchored on the
          SWE-rebench v2 SolverNet for v0.
        </p>
      </header>

      <IntroCard />
      <ShapeCatalogue />

      <Separator />
      <div className="flex items-center justify-between gap-4 pt-2">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]">
          Registry
        </span>
        <ArtifactTypeFilterChip value={artifactType} onChange={setArtifactType} />
      </div>

      {artifactType === 'plugin' ? (
        <>
          <PublishedPluginsPanel solverType={DEFAULT_SOLVER_TYPE} />
          <MyArtifactsPanel fleetAgentId={bootstrap?.fleet_agent_id} />
        </>
      ) : null}
    </div>
  );
}
