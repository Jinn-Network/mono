import { useState } from 'react';
import { useLocation } from 'wouter';
import { api } from '../../api/client.js';

/**
 * Wallet — single consolidated card on /overview that absorbed the
 * separate Funds, Rewards, and Identity cards plus the password-rotation
 * row. Four hairline-separated sections, all "small text" stats below
 * eyebrows so the card reads as one surface rather than four neighbours.
 *
 * Sections:
 *   - Gas       — ETH balance + runway as the headline stat, Top up faucet button
 *   - Rewards   — Claimable + Claimed as paired headline stats, Claim button
 *   - Identity  — Agent / Chain / Safe labelled triplet, preserves the
 *                 binding-pending inline retry flow from IdentityCard
 *   - Password  — Last rotated timestamp + Change Password button
 *                 (jumps to /operator/security)
 *
 * Two bits commented out per operator feedback:
 *   - The "per role" funds drill-down (the daemon only exposes master
 *     today; per-role surfaces nothing useful — issue #430)
 *   - The "last claim" timestamp under Rewards
 */
export interface ServiceIdentity {
  index: number;
  safeAddress: string;
  agentId: number | null;
  safeBoundToAgent: boolean;
}

export interface WalletCardProps {
  /** Sum of ETH across master / agent / Safe, formatted as decimal string */
  totalEth: string;
  /** Estimated days of runway at current burn rate. Accept string to allow "—" when unknown. */
  runwayDays: number | string;
  // perRole stays in the props so re-enabling the drill-down later is a
  // one-block restore. The daemon doesn't surface agent/safe balances yet
  // (#430), so showing the disclosure today renders three "—" rows.
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  perRole?: {
    master: string;
    agent: string;
    safe: string;
  };
  /** JINN currently claimable, formatted as decimal string */
  claimableJinn: string;
  /** JINN claimed lifetime, formatted as decimal string */
  claimedJinnLifetime: string;
  // lastClaimAt stays in the props so re-enabling the "last claim" row is
  // a one-block restore. Currently null because the daemon doesn't
  // surface it (tracked as a follow-up).
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  lastClaimAt?: string | null;
  agentId: number | null;
  chain: string;
  safeAddress: string | null;
  services?: ServiceIdentity[];
  bindingError?: string;
  /** ISO timestamp of last password rotation, or null if never rotated */
  lastPasswordRotationAt: string | null;
  onTopUp: () => void;
  onClaim: () => void;
  /** When true, action buttons are disabled (e.g. another action is in flight). */
  actionsDisabled?: boolean;
}

const EYEBROW: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 'var(--text-xs)',
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
};

const SECTION_LABEL: React.CSSProperties = {
  ...EYEBROW,
  color: 'var(--fg-dim)',
};

const SECTION_CONTAINER: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
};

const STAT_BIG: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 'var(--text-xl)',
  fontWeight: 500,
  color: 'var(--fg)',
  letterSpacing: '-0.01em',
};

const STAT_UNIT: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 'var(--text-sm)',
  color: 'var(--fg-muted)',
  fontWeight: 500,
};

const STAT_AUX: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 'var(--text-sm)',
  color: 'var(--fg-dim)',
};

const SMALL_BUTTON: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--accent-sky)',
  borderRadius: 'var(--radius-2)',
  color: 'var(--accent-sky)',
  cursor: 'pointer',
  fontFamily: 'var(--mono)',
  fontSize: 'var(--text-xs)',
  letterSpacing: '0.14em',
  padding: '6px 10px',
  textTransform: 'uppercase',
  alignSelf: 'flex-start',
};

const SMALL_BUTTON_GHOST: React.CSSProperties = {
  ...SMALL_BUTTON,
  border: '1px solid var(--border)',
  color: 'var(--fg-muted)',
};

const DIVIDER: React.CSSProperties = {
  border: 0,
  borderTop: '1px solid var(--border)',
  margin: 0,
};

function trunc(addr: string | null | undefined): string {
  if (!addr || addr.length < 10) return addr ?? '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletCard({
  totalEth,
  runwayDays,
  claimableJinn,
  claimedJinnLifetime,
  agentId,
  chain,
  safeAddress,
  services = [],
  bindingError,
  lastPasswordRotationAt,
  onTopUp,
  onClaim,
  actionsDisabled = false,
}: WalletCardProps): JSX.Element {
  const [, navigate] = useLocation();
  const canClaim = parseFloat(claimableJinn) > 0;

  // ── Identity binding-pending retry — preserved from IdentityCard ──
  const pendingBinding = services.find((s) => s.agentId !== null && !s.safeBoundToAgent);
  const [bindingOpen, setBindingOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<'success' | 'reverted' | null>(null);
  const [retryDetail, setRetryDetail] = useState<string | null>(bindingError ?? null);

  const retry = async (): Promise<void> => {
    if (!pendingBinding) return;
    setRetrying(true);
    setRetryResult(null);
    setRetryDetail(null);
    try {
      const res = await api.retryAgentBinding({ serviceIndex: pendingBinding.index });
      const attempt = res.attempts[0];
      if (attempt?.status === 'success') {
        setRetryResult('success');
        setBindingOpen(false);
      } else {
        setRetryResult('reverted');
        setRetryDetail(attempt?.detail ?? 'Bind reverted on chain.');
      }
    } catch (err) {
      setRetryResult('reverted');
      setRetryDetail(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <section
      role="region"
      aria-label="Wallet"
      data-testid="wallet-card"
      className="j-surface-secondary"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
      }}
    >
      <span style={EYEBROW}>Wallet</span>

      {/* ── GAS ───────────────────────────────────────────────────────── */}
      <div style={SECTION_CONTAINER} data-testid="wallet-section-gas">
        <span style={SECTION_LABEL}>Gas</span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <span style={STAT_BIG}>{totalEth}</span>
          <span style={STAT_UNIT}>ETH</span>
          <span style={STAT_AUX}>·</span>
          <span style={STAT_AUX}>{runwayDays}d runway</span>
        </div>
        {/*
          PER ROLE drill-down is commented out — the daemon only exposes
          masterGas today, so the disclosure renders agent + safe as "—".
          Re-enable when /v1/status surfaces per-role balances (#430).

        <button type="button" aria-expanded={false} onClick={() => {}} style={{ alignSelf: 'flex-start', ... }}>
          per role
        </button>
        */}
        <button
          type="button"
          aria-label="Top up from faucet"
          onClick={onTopUp}
          disabled={actionsDisabled}
          data-testid="wallet-topup"
          style={{
            ...SMALL_BUTTON,
            opacity: actionsDisabled ? 0.55 : 1,
            cursor: actionsDisabled ? 'not-allowed' : 'pointer',
            border: `1px solid ${actionsDisabled ? 'var(--border)' : 'var(--accent-sky)'}`,
            color: actionsDisabled ? 'var(--fg-dim)' : 'var(--accent-sky)',
          }}
        >
          Top up from faucet (free)
        </button>
      </div>

      <hr style={DIVIDER} />

      {/* ── REWARDS ───────────────────────────────────────────────────── */}
      <div style={SECTION_CONTAINER} data-testid="wallet-section-rewards">
        <span style={SECTION_LABEL}>Rewards</span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <span style={{ ...EYEBROW, color: 'var(--fg-dim)' }}>Claimable</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
            <span style={STAT_BIG}>{claimableJinn}</span>
            <span style={STAT_UNIT}>JINN</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <span style={{ ...EYEBROW, color: 'var(--fg-dim)' }}>Claimed</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
            <span style={STAT_BIG}>{claimedJinnLifetime}</span>
            <span style={STAT_UNIT}>JINN</span>
          </div>
          <button
            type="button"
            aria-label="Claim"
            onClick={onClaim}
            disabled={!canClaim || actionsDisabled}
            data-testid="wallet-claim"
            style={{
              ...SMALL_BUTTON,
              marginTop: 'var(--space-2)',
              border: `1px solid ${canClaim && !actionsDisabled ? 'var(--accent-sky)' : 'var(--border)'}`,
              color: canClaim && !actionsDisabled ? 'var(--accent-sky)' : 'var(--fg-dim)',
              cursor: canClaim && !actionsDisabled ? 'pointer' : 'not-allowed',
              opacity: canClaim && !actionsDisabled ? 1 : 0.5,
            }}
          >
            Claim
          </button>
        </div>
        {/*
          LAST CLAIM timestamp commented out per operator feedback —
          it added a "never" line under an already-empty section. Restore
          if/when the daemon ships `lastClaimAt` (tracked alongside #441).

        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-dim)' }}>
          last claim: {lastClaimAt ? <time dateTime={lastClaimAt}>{lastClaimAt}</time> : 'never'}
        </span>
        */}
      </div>

      <hr style={DIVIDER} />

      {/* ── IDENTITY ──────────────────────────────────────────────────── */}
      <div style={SECTION_CONTAINER} data-testid="wallet-section-identity">
        <span style={SECTION_LABEL}>Identity</span>
        <div style={{ display: 'flex', gap: 'var(--space-6)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <span style={{ ...EYEBROW, color: 'var(--fg-dim)' }}>Agent</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-base)', color: 'var(--fg)', display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              {agentId !== null ? `#${agentId}` : '—'}
              {pendingBinding && (
                <button
                  type="button"
                  onClick={() => setBindingOpen((o) => !o)}
                  style={{
                    fontSize: 'var(--text-2xs)',
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    fontFamily: 'var(--mono)',
                    border: '1px solid var(--wane)',
                    color: 'var(--wane)',
                    background: 'transparent',
                    borderRadius: 'var(--radius-pill)',
                    padding: '1px 6px',
                    cursor: 'pointer',
                  }}
                >
                  binding pending
                </button>
              )}
              {retryResult === 'success' && (
                <span
                  style={{
                    fontSize: 'var(--text-2xs)',
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    border: '1px solid var(--vow-green)',
                    color: 'var(--vow-green)',
                    borderRadius: 'var(--radius-pill)',
                    padding: '1px 6px',
                  }}
                >
                  bound
                </span>
              )}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <span style={{ ...EYEBROW, color: 'var(--fg-dim)' }}>Chain</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-base)', color: 'var(--fg)' }}>{chain}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <span style={{ ...EYEBROW, color: 'var(--fg-dim)' }}>Safe</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-base)', color: 'var(--fg)' }}>{trunc(safeAddress)}</span>
          </div>
        </div>
        {bindingOpen && pendingBinding && (
          <div
            style={{
              marginTop: 'var(--space-2)',
              padding: '12px 14px',
              border: '1px solid var(--wane)',
              borderRadius: 'var(--radius-2)',
              background: 'rgba(184, 128, 47, 0.07)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
            }}
          >
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg)' }}>
              Service #{pendingBinding.index} Safe is not yet bound to agent #{pendingBinding.agentId}.
              The bootstrap left it unbound; retry to attempt the ERC-1271 bind again.
            </span>
            {retryDetail && (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--break-red)' }}>{retryDetail}</span>
            )}
            <button
              type="button"
              onClick={() => { void retry(); }}
              disabled={retrying}
              style={{
                alignSelf: 'flex-start',
                border: '1px solid var(--accent-sky)',
                background: 'var(--accent-sky)',
                color: 'var(--bg-sunken)',
                borderRadius: 'var(--radius-2)',
                padding: '8px 14px',
                fontFamily: 'var(--mono)',
                fontSize: 'var(--text-sm)',
                cursor: retrying ? 'wait' : 'pointer',
              }}
            >
              {retrying ? 'Retrying…' : 'Retry binding'}
            </button>
          </div>
        )}
      </div>

      <hr style={DIVIDER} />

      {/* ── PASSWORD ──────────────────────────────────────────────────── */}
      <div style={SECTION_CONTAINER} data-testid="wallet-section-password">
        <span style={SECTION_LABEL}>Password</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-sm)', color: 'var(--fg-dim)' }}>
          last rotated:{' '}
          {lastPasswordRotationAt ? (
            <time dateTime={lastPasswordRotationAt} style={{ color: 'var(--fg-muted)' }}>
              {lastPasswordRotationAt}
            </time>
          ) : (
            <span style={{ color: 'var(--fg-muted)' }}>never</span>
          )}
        </span>
        <button
          type="button"
          aria-label="Change password"
          onClick={() => navigate('/operator/security')}
          data-testid="wallet-change-password"
          style={SMALL_BUTTON_GHOST}
        >
          Change password
        </button>
      </div>
    </section>
  );
}
