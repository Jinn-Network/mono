import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type { DiscoveryBuilderArtifactsResponse } from '../../api/types.js';
import { PanelCard } from '../../components/PanelCard.js';

const cellStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border)',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '12px',
  color: 'var(--fg)',
};
const headCellStyle: React.CSSProperties = {
  ...cellStyle,
  color: 'var(--fg-muted)',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  fontSize: '10px',
};

export function MyArtifactsPanel({ fleetAgentId }: { fleetAgentId: string | undefined }): JSX.Element {
  const enabled = Boolean(fleetAgentId);
  const { data, isLoading, error } = useQuery<DiscoveryBuilderArtifactsResponse>({
    queryKey: ['discovery', 'builder-artifacts', fleetAgentId],
    queryFn: () => api.discovery.listBuilderArtifacts(fleetAgentId!),
    enabled,
    refetchInterval: 30_000,
  });

  if (!enabled) {
    return (
      <PanelCard
        title="Your published plug-ins"
        style={{ border: '1px dashed var(--border)', background: 'var(--surface-sunken)' }}
      >
        <p style={{ color: 'var(--fg-muted)' }}>
          Complete identity bootstrap to see your published plug-ins. Run{' '}
          <code>jinn solver-plugins publish</code> on a plug-in and the lazy stage-ensure will provision
          your builder identity (Stage 1).
        </p>
      </PanelCard>
    );
  }

  if (isLoading) {
    return <section style={{ padding: '24px', color: 'var(--fg-muted)' }}>Loading your plug-ins…</section>;
  }
  if (error) {
    return <section style={{ padding: '24px', color: 'var(--break-red)' }}>Discovery unavailable.</section>;
  }

  const rows = (data?.artifacts ?? []).filter((a) => a.artifactType === 'plugin');

  if (rows.length === 0) {
    return (
      <PanelCard title="Your published plug-ins">
        <p style={{ color: 'var(--fg-dim)' }}>You have not published any plug-ins yet.</p>
      </PanelCard>
    );
  }

  return (
    <PanelCard title="Your published plug-ins">
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={headCellStyle}>Plug-in</th>
              <th style={headCellStyle}>Version</th>
              <th style={headCellStyle}>Supports</th>
              <th style={headCellStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.builderAgentId}:${r.cid}`}>
                <td style={cellStyle}>{r.name}</td>
                <td style={cellStyle}>{r.version}</td>
                <td style={{ ...cellStyle, color: 'var(--fg-muted)' }}>{r.supports.join(', ')}</td>
                <td style={cellStyle}>
                  {r.revoked ? <span style={{ color: 'var(--wane)' }}>revoked</span> : <span style={{ color: 'var(--vow-green)' }}>active</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PanelCard>
  );
}
