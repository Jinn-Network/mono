import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type { DiscoveryBuilderArtifactsResponse } from '../../api/types.js';
import { PanelCard } from '../../components/PanelCard.js';

const cellStyle: React.CSSProperties = {
  padding: '12px',
  borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--mono)',
  fontSize: '12px',
  lineHeight: 1.6,
  color: 'var(--fg)',
};

const headCellStyle: React.CSSProperties = {
  ...cellStyle,
  color: 'var(--fg-dim)',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  fontSize: '11px',
  textAlign: 'left',
};

const statusChip = (color: string): React.CSSProperties => ({
  display: 'inline-block',
  fontFamily: 'var(--mono)',
  fontSize: '10px',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  padding: '2px 10px',
  borderRadius: 'var(--radius-pill)',
  border: `1px solid ${color}`,
  color,
});

function PanelHeader(): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '20px' }}>
      <span className="j-label">Builder</span>
      <h3
        className="j-display"
        style={{ fontSize: '22px', lineHeight: 1.25, color: 'var(--fg)', margin: 0 }}
      >
        Your published plug-ins
      </h3>
    </div>
  );
}

const inlineCode: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '12px',
  color: 'var(--accent-sky)',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-1)',
  padding: '1px 6px',
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
      <PanelCard style={{ background: 'var(--bg-sunken)' }}>
        <PanelHeader />
        <div
          style={{
            border: '1px dashed var(--border)',
            borderRadius: 'var(--radius-2)',
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <span className="j-label">Identity pending</span>
          <p
            className="j-mono"
            style={{
              color: 'var(--fg-muted)',
              fontSize: '13px',
              lineHeight: 1.7,
              margin: 0,
              maxWidth: '64ch',
            }}
          >
            Complete identity bootstrap to see your published plug-ins. Run{' '}
            <code style={inlineCode}>jinn solver-plugins publish</code> on a
            plug-in and the lazy stage-ensure will provision your builder
            identity (Stage 1).
          </p>
        </div>
      </PanelCard>
    );
  }

  if (isLoading) {
    return (
      <PanelCard>
        <PanelHeader />
        <p className="j-mono" style={{ color: 'var(--fg-muted)', fontSize: '13px', margin: 0 }}>
          Loading your plug-ins…
        </p>
      </PanelCard>
    );
  }
  if (error) {
    return (
      <PanelCard>
        <PanelHeader />
        <p className="j-mono" style={{ color: 'var(--break-red)', fontSize: '13px', margin: 0 }}>
          Discovery unavailable.
        </p>
      </PanelCard>
    );
  }

  const rows = (data?.artifacts ?? []).filter((a) => a.artifactType === 'plugin');

  if (rows.length === 0) {
    return (
      <PanelCard>
        <PanelHeader />
        <div
          style={{
            border: '1px dashed var(--border)',
            borderRadius: 'var(--radius-2)',
            padding: '24px',
            background: 'var(--bg-sunken)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <span className="j-label">Nothing yet</span>
          <p
            className="j-mono"
            style={{
              color: 'var(--fg-muted)',
              fontSize: '13px',
              lineHeight: 1.7,
              margin: 0,
              maxWidth: '64ch',
            }}
          >
            You have not published any plug-ins yet. Scaffold one with{' '}
            <code style={inlineCode}>jinn create plugin</code>, then publish
            with <code style={inlineCode}>jinn solver-plugins publish</code>.
            It will appear here under your builder agentId.
          </p>
        </div>
      </PanelCard>
    );
  }

  return (
    <PanelCard>
      <PanelHeader />
      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            borderTop: '1px solid var(--border)',
          }}
        >
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
                <td style={{ ...cellStyle, color: 'var(--fg-muted)' }}>{r.version}</td>
                <td style={{ ...cellStyle, color: 'var(--fg-muted)' }}>{r.supports.join(', ')}</td>
                <td style={cellStyle}>
                  {r.revoked ? (
                    <span style={statusChip('var(--wane)')}>Revoked</span>
                  ) : (
                    <span style={statusChip('var(--vow-green)')}>Active</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PanelCard>
  );
}
