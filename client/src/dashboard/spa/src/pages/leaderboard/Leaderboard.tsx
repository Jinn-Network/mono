import { useState } from 'react';
import { TrainLeaderboardTable } from './TrainLeaderboardTable.js';
import { FrozenLeaderboardTable } from './FrozenLeaderboardTable.js';

type LeaderboardTab = 'train' | 'frozen';

function tabButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '8px 16px',
    background: 'none',
    border: 'none',
    borderBottom: `2px solid ${active ? 'var(--accent-sky)' : 'transparent'}`,
    fontFamily: "'JetBrains Mono', ui-monospace, SF Mono, Menlo, monospace",
    fontSize: '11px',
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
    color: active ? 'var(--fg)' : 'var(--fg-muted)',
    cursor: 'pointer',
    marginBottom: '-1px',
  };
}

export function LeaderboardPage({ solverNet }: { solverNet: string }): JSX.Element {
  const [tab, setTab] = useState<LeaderboardTab>('train');
  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div
        role="tablist"
        style={{
          display: 'flex',
          borderBottom: '1px solid var(--border)',
          gap: '4px',
        }}
      >
        <button
          role="tab"
          aria-selected={tab === 'train'}
          style={tabButtonStyle(tab === 'train')}
          onClick={() => { setTab('train'); }}
        >
          Train
        </button>
        <button
          role="tab"
          aria-selected={tab === 'frozen'}
          style={tabButtonStyle(tab === 'frozen')}
          onClick={() => { setTab('frozen'); }}
        >
          Frozen
        </button>
      </div>
      {tab === 'train' ? (
        <TrainLeaderboardTable solverNet={solverNet} />
      ) : (
        <FrozenLeaderboardTable solverNet={solverNet} />
      )}
    </div>
  );
}
