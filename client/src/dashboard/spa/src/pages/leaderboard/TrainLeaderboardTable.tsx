import { useQuery } from '@tanstack/react-query';

interface TrainRollup {
  implName: string;
  codeDigest: string;
  meanResolved: number;
  verdictCount: number;
  uniqueOperators: number;
}

interface LeaderboardResponse {
  rollups: TrainRollup[];
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

export function TrainLeaderboardTable({ solverNet }: { solverNet: string }): JSX.Element {
  const { data, isLoading } = useQuery<LeaderboardResponse>({
    queryKey: ['leaderboard', solverNet, 'train'],
    queryFn: async () => {
      const res = await fetch(`/api/solvernets/${encodeURIComponent(solverNet)}/leaderboard?mode=train`, {
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
        No train-mode verdicts recorded yet.
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
