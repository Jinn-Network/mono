import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type { DiscoveryPluginPublicationsResponse, PluginPublicationDto } from '../../api/types.js';
import { PanelCard } from '../../components/PanelCard.js';

const cellStyle: React.CSSProperties = {
  padding: '12px',
  borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--mono)',
  fontSize: '12px',
  lineHeight: 1.6,
  color: 'var(--fg)',
  verticalAlign: 'top',
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

function truncate(cid: string): string {
  return cid.length > 14 ? `${cid.slice(0, 8)}…${cid.slice(-4)}` : cid;
}

/**
 * Render the panel header — eyebrow + serif title — preserving the
 * literal phrase "Published plug-ins for <solverType>" so the BuildPage
 * test's `getByText` matcher still resolves. The eyebrow / title pair
 * replaces the old <h3> rendered by PanelCard's `title` prop.
 */
function PanelHeader({ solverType }: { solverType: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '20px' }}>
      <span className="j-label">Registry</span>
      <h3
        className="j-display"
        style={{ fontSize: '22px', lineHeight: 1.25, color: 'var(--fg)', margin: 0 }}
      >
        Published plug-ins for {solverType}
      </h3>
    </div>
  );
}

export function PublishedPluginsPanel({ solverType }: { solverType: string }): JSX.Element {
  const { data, isLoading, error } = useQuery<DiscoveryPluginPublicationsResponse>({
    queryKey: ['discovery', 'plugin-publications', solverType],
    queryFn: () => api.discovery.listPluginPublications({ solverType }),
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <PanelCard>
        <PanelHeader solverType={solverType} />
        <p className="j-mono" style={{ color: 'var(--fg-muted)', fontSize: '13px', margin: 0 }}>
          Loading published plug-ins…
        </p>
      </PanelCard>
    );
  }

  if (error) {
    return (
      <PanelCard>
        <PanelHeader solverType={solverType} />
        <p
          className="j-mono"
          style={{ color: 'var(--break-red)', fontSize: '13px', margin: 0, lineHeight: 1.7 }}
        >
          Discovery unavailable. {(error as Error).message}
        </p>
      </PanelCard>
    );
  }

  const rows = data?.publications ?? [];

  if (rows.length === 0) {
    return (
      <PanelCard>
        <PanelHeader solverType={solverType} />
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
          <span className="j-label">Empty registry</span>
          <p
            className="j-mono"
            style={{
              color: 'var(--fg)',
              fontSize: '13px',
              lineHeight: 1.7,
              margin: 0,
              maxWidth: '64ch',
            }}
          >
            No plug-ins published yet. Be the first.
          </p>
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
            Run{' '}
            <code
              style={{
                fontFamily: 'var(--mono)',
                fontSize: '12px',
                color: 'var(--accent-sky)',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-1)',
                padding: '1px 6px',
              }}
            >
              jinn solver-plugins publish
            </code>{' '}
            and your plug-in appears here under your builder agentId.
          </p>
        </div>
      </PanelCard>
    );
  }

  return (
    <PanelCard>
      <PanelHeader solverType={solverType} />
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
              <th style={headCellStyle}>Builder agentId</th>
              <th style={headCellStyle}>CID</th>
              <th style={headCellStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: PluginPublicationDto) => (
              <tr key={`${r.builderAgentId}:${r.cid}`}>
                <td style={cellStyle}>{r.name}</td>
                <td style={{ ...cellStyle, color: 'var(--fg-muted)' }}>{r.version}</td>
                <td style={{ ...cellStyle, color: 'var(--fg-muted)' }}>{r.builderAgentId}</td>
                <td style={{ ...cellStyle, color: 'var(--fg-muted)' }}>{truncate(r.cid)}</td>
                <td style={cellStyle}>
                  {r.revoked ? (
                    <span style={statusChip('var(--wane)')}>
                      Revoked{r.revokedReason ? ` · ${r.revokedReason}` : ''}
                    </span>
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
