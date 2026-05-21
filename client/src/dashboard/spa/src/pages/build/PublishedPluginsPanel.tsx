import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type { DiscoveryPluginPublicationsResponse, PluginPublicationDto } from '../../api/types.js';
import { PanelCard } from '../../components/PanelCard.js';

const cellStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border)',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '12px',
  color: 'var(--fg)',
  verticalAlign: 'top',
};
const headCellStyle: React.CSSProperties = {
  ...cellStyle,
  color: 'var(--fg-muted)',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  fontSize: '10px',
};

function truncate(cid: string): string {
  return cid.length > 14 ? `${cid.slice(0, 8)}…${cid.slice(-4)}` : cid;
}

export function PublishedPluginsPanel({ solverType }: { solverType: string }): JSX.Element {
  const { data, isLoading, error } = useQuery<DiscoveryPluginPublicationsResponse>({
    queryKey: ['discovery', 'plugin-publications', solverType],
    queryFn: () => api.discovery.listPluginPublications({ solverType }),
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <section style={{ padding: '24px', color: 'var(--fg-muted)' }}>Loading published plug-ins…</section>
    );
  }

  if (error) {
    return (
      <section style={{ padding: '24px', color: 'var(--break-red)' }}>
        Discovery unavailable. {(error as Error).message}
      </section>
    );
  }

  const rows = data?.publications ?? [];

  if (rows.length === 0) {
    return (
      <PanelCard title={`Published plug-ins for ${solverType}`}>
        <p style={{ color: 'var(--fg-dim)' }}>No plug-ins published yet. Be the first.</p>
      </PanelCard>
    );
  }

  return (
    <PanelCard title={`Published plug-ins for ${solverType}`}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
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
                <td style={cellStyle}>{r.version}</td>
                <td style={{ ...cellStyle, color: 'var(--fg-muted)' }}>{r.builderAgentId}</td>
                <td style={{ ...cellStyle, color: 'var(--fg-muted)' }}>{truncate(r.cid)}</td>
                <td style={cellStyle}>
                  {r.revoked ? (
                    <span style={{ color: 'var(--wane)' }}>revoked{r.revokedReason ? ` — ${r.revokedReason}` : ''}</span>
                  ) : (
                    <span style={{ color: 'var(--vow-green)' }}>active</span>
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
