export interface RewardsCardProps {
  /** JINN currently claimable, formatted as decimal string */
  claimableJinn: string;
  /** JINN claimed lifetime, formatted as decimal string */
  claimedJinnLifetime: string;
  /** ISO timestamp of most recent claim, or null if never claimed */
  lastClaimAt: string | null;
  onClaim: () => void;
}

export function RewardsCard({
  claimableJinn,
  claimedJinnLifetime,
  lastClaimAt,
  onClaim,
}: RewardsCardProps): JSX.Element {
  const canClaim = parseFloat(claimableJinn) > 0;

  return (
    <article
      role="region"
      aria-label="Rewards"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {/* Eyebrow */}
      <span
        style={{
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        Rewards
      </span>

      {/* Primary balance row — claimable */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: '28px',
            fontWeight: 500,
            color: 'var(--fg)',
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: '-0.02em',
          }}
        >
          {claimableJinn}
        </span>
        <span
          style={{
            fontSize: '13px',
            color: 'var(--fg-muted)',
            fontWeight: 500,
          }}
        >
          JINN
        </span>
        <span style={{ fontSize: '13px', color: 'var(--fg-dim)' }}>claimable</span>
      </div>

      {/* Stats: lifetime claimed */}
      <dl
        style={{
          margin: 0,
          padding: '12px 14px',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          background: 'var(--bg-sunken, rgba(0,0,0,0.15))',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: '12px',
          }}
        >
          <dt
            style={{
              fontSize: '11px',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--fg-dim)',
              margin: 0,
            }}
          >
            claimed
          </dt>
          <dd
            style={{
              fontSize: '13px',
              color: 'var(--fg)',
              margin: 0,
              fontFamily: "'JetBrains Mono', monospace",
              display: 'flex',
              gap: '4px',
              alignItems: 'baseline',
            }}
          >
            <span>{claimedJinnLifetime}</span>
            <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>JINN</span>
          </dd>
        </div>
      </dl>

      {/* Footer: last claim + action */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          marginTop: '4px',
          paddingTop: '12px',
          borderTop: '1px solid var(--border)',
        }}
      >
        <span style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>
          last claim:{' '}
          {lastClaimAt ? (
            <time dateTime={lastClaimAt} style={{ color: 'var(--fg-muted)' }}>
              {lastClaimAt}
            </time>
          ) : (
            <span style={{ color: 'var(--fg-muted)' }}>never</span>
          )}
        </span>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            aria-label="Claim"
            onClick={onClaim}
            disabled={!canClaim}
            style={{
              border: `1px solid ${canClaim ? 'var(--accent-sky)' : 'var(--border)'}`,
              color: canClaim ? 'var(--accent-sky)' : 'var(--fg-dim)',
              background: 'transparent',
              borderRadius: '6px',
              padding: '6px 12px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              cursor: canClaim ? 'pointer' : 'not-allowed',
              opacity: canClaim ? 1 : 0.5,
            }}
          >
            Claim
          </button>
        </div>
      </div>
    </article>
  );
}
