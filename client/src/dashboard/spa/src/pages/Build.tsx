import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client.js';
import type { BootstrapState } from '../api/types.js';
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
 * is sourced live from `client/docs/build/quickstart.md`. The shape
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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
        padding: '24px',
        maxWidth: 1100,
        margin: '0 auto',
      }}
    >
      <IntroCard />
      <ShapeCatalogue />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
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
