import { useQuery } from '@tanstack/react-query';
import { VerifiedBadge } from './VerifiedBadge.js';

interface FrozenRollup {
  implName: string;
  codeDigest: string;
  meanResolved: number;
  verdictCount: number;
  uniqueOperators: number;
  verified: boolean | null;
}

interface LeaderboardResponse {
  rollups: FrozenRollup[];
}

const cellStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border)',
  fontFamily: "'JetBrains Mono', ui-monospace, SF Mono, Menlo, monospace",
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

export function FrozenLeaderboardTable({ solverNet }: { solverNet: string }): JSX.Element {
  const { data, isLoading } = useQuery<LeaderboardResponse>({
    queryKey: ['leaderboard', solverNet, 'frozen'],
    queryFn: async () => {
      const res = await fetch(`/api/solvernets/${encodeURIComponent(solverNet)}/leaderboard?mode=frozen`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<LeaderboardResponse>;
    },
    refetchInterval: 15_000,
  });

  const rollups = data?.rollups ?? [];

  if (isLoading) {
    return (
      <div style={{ padding: '24px', color: 'var(--fg-muted)', fontSize: '13px' }}>
        Loading…
      </div>
    );
  }

  if (rollups.length === 0) {
    return (
      <div style={{ padding: '24px', color: 'var(--fg-dim)', fontSize: '13px' }}>
        No frozen-mode verdicts recorded yet.
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={headCellStyle}>Harness</th>
            <th style={headCellStyle}>codeDigest</th>
            <th style={{ ...headCellStyle, textAlign: 'right' }}>Mean resolved</th>
            <th style={{ ...headCellStyle, textAlign: 'right' }}>n</th>
            <th style={{ ...headCellStyle, textAlign: 'right' }}>Operators</th>
            <th style={headCellStyle}></th>
          </tr>
        </thead>
        <tbody>
          {rollups.map((r) => (
            <tr key={r.codeDigest}>
              <td style={cellStyle}>{r.implName}</td>
              <td style={{ ...cellStyle, color: 'var(--fg-muted)' }}>
                {r.codeDigest.slice(0, 16)}…
              </td>
              <td style={{ ...cellStyle, textAlign: 'right' }}>
                {(r.meanResolved * 100).toFixed(1)}%
              </td>
              <td style={{ ...cellStyle, textAlign: 'right' }}>{r.verdictCount}</td>
              <td style={{ ...cellStyle, textAlign: 'right' }}>{r.uniqueOperators}</td>
              <td style={cellStyle}>
                <VerifiedBadge verified={r.verified} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
