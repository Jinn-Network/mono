import { useLocation } from 'wouter';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Separator } from '../../components/ui/separator.js';
import { TooltipProvider } from '../../components/ui/tooltip.js';
import type { StakingRewardReadState } from '../../../../../api/contract/index.js';

import type { JSX } from 'react';

/**
 * Wallet — three hairline-separated sections — Rewards, Gas, Password —
 * now that Identity lives in its own card per OPERATOR-APP-SPEC §2.2. The
 * identity block was promoted out of the wallet card in #427; see
 * IdentityCard.tsx for the relocated stats + retryAgentBinding flow.
 *
 * Migrated to shadcn primitives (Card, Button, Separator). The TooltipProvider
 * stays in scope so a future re-addition of address tooltips here is a
 * one-import restore.
 */
export interface ServiceIdentity {
  index: number;
  /** On-chain service id (OLAS ServiceRegistry token). Null until bootstrap registers the service. */
  serviceId: number | null;
  safeAddress: string;
  agentId: number | null;
  safeBoundToAgent: boolean;
}

export interface WalletCardProps {
  /** Sum of ETH across master / agent / Safe, formatted as decimal string */
  totalEth: string;
  /** Estimated days of runway at current burn rate. Accept string to allow "—" when unknown. */
  runwayDays: number | string;
  /**
   * Severity tint for the runway line (#1296). `warning` when runway is below
   * the low threshold, `blocking` when the wallet can no longer cover the next
   * transaction, `null`/absent for the flat default. Reads in greyscale via the
   * shared severity tokens — the banner is the primary surface, this is the
   * in-card echo.
   */
  runwaySeverity?: 'warning' | 'blocking' | null;
  // perRole stays in the props so re-enabling the drill-down later is a
  // one-block restore. Real values are wired via #430; the drill-down rows
  // are commented out pending a follow-up Issue.
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  perRole?: {
    master: string;
    agent: string;
    safe: string;
  };
  /** Pending OLAS available to claim, formatted for display. */
  olasPending: string;
  /** Lifetime claimed OLAS, formatted for display. */
  olasClaimed: string;
  /** Claimed OLAS recorded in the last 24 hours, formatted for display. */
  olasClaimedLast24h: string | null;
  /** Read state for the OLAS reward figures. */
  olasState: StakingRewardReadState;
  /** Public read error string when rewards are unavailable. */
  olasError?: string | null;
  /** Last successful claim timestamp, if any. */
  lastClaimAt?: string | null;
  /** ISO timestamp of last password rotation, or null if never rotated */
  lastPasswordRotationAt: string | null;
  onTopUp: () => void;
  onClaim: () => void;
  claimPending?: boolean;
  /** When true, action buttons are disabled (e.g. another action is in flight). */
  actionsDisabled?: boolean;
  /**
   * Batched faucet top-up quota (issue #560). When provided, the card surfaces
   * how many top-ups remain today and disables the button once the daily cap is
   * reached, showing when the 24h cooldown resets. All optional for
   * back-compat: when undefined the button stays enabled with no quota copy.
   */
  topupDailyCap?: number;
  topupCallsRemaining?: number;
  topupCooldownExpiresAt?: number | null;
}

/**
 * Human-readable "resets in …" using Intl.RelativeTimeFormat. Picks the
 * coarsest sensible unit (days → hours → minutes). Returns null when the
 * expiry is unknown or already past.
 */
function formatResetIn(cooldownExpiresAt: number | null | undefined): string | null {
  if (cooldownExpiresAt == null) return null;
  const deltaMs = cooldownExpiresAt - Date.now();
  if (deltaMs <= 0) return null;
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(deltaMs / 3_600_000);
  if (hours < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(deltaMs / 86_400_000), 'day');
}

const eyebrow = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-muted)]';
const sectionLabel = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]';
const statBig = 'font-mono text-[24px] font-medium tracking-[-0.01em] text-foreground';
const statUnit = 'font-mono text-[12px] font-medium text-[var(--fg-muted)]';
const statAux = 'font-mono text-[12px] text-[var(--fg-dim)]';

/**
 * Display value + supporting copy for the pending OLAS row, keyed on the read
 * state.
 */
function olasDisplay(
  state: StakingRewardReadState,
  olasPending: string,
  olasError: string | null | undefined,
): { value: string; copy: string | null } {
  switch (state) {
    case 'ready':
      return { value: olasPending, copy: null };
    case 'error':
      return {
        value: 'unavailable',
        copy: olasError ?? 'Your OLAS rewards are temporarily unavailable.',
      };
    case 'pending':
      return { value: 'pending', copy: 'No rewards yet — they show up here as your node earns them.' };
  }
}

export function WalletCard({
  totalEth,
  runwayDays,
  runwaySeverity = null,
  olasPending,
  olasClaimed,
  olasClaimedLast24h,
  olasState,
  olasError,
  lastClaimAt,
  lastPasswordRotationAt,
  onTopUp,
  onClaim,
  claimPending = false,
  actionsDisabled = false,
  topupDailyCap,
  topupCallsRemaining,
  topupCooldownExpiresAt,
}: WalletCardProps): JSX.Element {
  const [, navigate] = useLocation();
  const { value: olasValue, copy: olasStateCopy } = olasDisplay(
    olasState,
    olasPending,
    olasError,
  );
  const pendingOlasNumber = Number.parseFloat(olasPending);
  const hasPendingOlas = Number.isFinite(pendingOlasNumber) && pendingOlasNumber > 0;
  const claimDisabled = actionsDisabled || claimPending || olasState !== 'ready' || !hasPendingOlas;

  // Issue #560: quota copy + disable. When the cap is reached the button is
  // disabled until the cooldown resets; while quota remains we show how many
  // top-ups are left today. Quota props undefined → no copy, button enabled.
  const quotaKnown = topupCallsRemaining !== undefined && topupDailyCap !== undefined;
  const capReached = quotaKnown && topupCallsRemaining === 0;
  const resetIn = formatResetIn(topupCooldownExpiresAt);
  const topupCopy = !quotaKnown
    ? null
    : capReached
      ? resetIn
        ? `Daily faucet cap reached · resets ${resetIn}`
        : 'Daily faucet cap reached'
      : `${topupCallsRemaining} of ${topupDailyCap} top-ups left today`;

  return (
    <TooltipProvider delayDuration={150}>
      <Card
        role="region"
        aria-label="Wallet"
        data-testid="wallet-card"
        className="flex flex-col gap-6 p-6"
      >
        <span className={eyebrow}>Wallet</span>

        {/* ── REWARDS ───────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3" data-testid="wallet-section-rewards">
          <span className={sectionLabel}>Rewards</span>

          <div
            className="flex flex-col gap-1"
            data-testid="olas-pending-region"
            aria-live="polite"
            aria-atomic="true"
          >
            <p className="text-sm font-medium text-muted-foreground">
              Pending OLAS
            </p>
            <div className="flex items-baseline gap-2">
              <span
                className="text-2xl font-bold tracking-tight"
                data-testid="olas-pending-value"
                style={olasState === 'error' ? { color: 'var(--break-red)' } : undefined}
              >
                {olasValue}
              </span>
              {olasState === 'ready' && (
                <span className="text-xs text-muted-foreground">OLAS</span>
              )}
            </div>
            {olasStateCopy && (
              <span className="text-xs text-muted-foreground" data-testid="olas-pending-state">
                {olasStateCopy}
              </span>
            )}
          </div>

          <div
            className="flex flex-col gap-1"
            data-testid="olas-claimed-24h-region"
            aria-live="polite"
            aria-atomic="true"
          >
            <p className="text-xs text-muted-foreground">
              Claimed last 24hrs
            </p>
            <div className="flex items-baseline gap-2">
              <span
                className="text-base font-medium"
                data-testid="olas-claimed-24h-value"
                style={olasState === 'error' ? { color: 'var(--break-red)' } : undefined}
              >
                {olasClaimedLast24h ?? (olasState === 'error' ? 'unavailable' : 'pending')}
              </span>
              {olasClaimedLast24h !== null && (
                <span className="text-xs text-muted-foreground">OLAS</span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-muted-foreground">Lifetime claimed</span>
              <span className="text-base font-medium" data-testid="olas-claimed-value">
                {olasState === 'error' ? 'unavailable' : olasClaimed}
              </span>
              {olasState !== 'error' && <span className="text-xs text-muted-foreground">OLAS</span>}
            </div>
            {lastClaimAt && (
              <span className="text-xs text-muted-foreground">
                last claim <time dateTime={lastClaimAt}>{lastClaimAt}</time>
              </span>
            )}
          </div>

          <Button
            variant="secondary"
            size="sm"
            aria-label="Claim OLAS"
            onClick={onClaim}
            disabled={claimDisabled}
            data-testid="wallet-claim"
            className="self-start"
          >
            {claimPending ? 'Claiming OLAS' : 'Claim OLAS'}
          </Button>
        </div>

        <Separator />

        {/* ── GAS ───────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3" data-testid="wallet-section-gas">
          <span className={sectionLabel}>Gas</span>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className={statBig}>{totalEth}</span>
            <span className={statUnit}>ETH</span>
            <span className={statAux}>·</span>
            <span
              data-testid="wallet-runway"
              data-runway-severity={runwaySeverity ?? 'none'}
              className={statAux}
              style={
                runwaySeverity === 'blocking'
                  ? { color: 'var(--severity-blocking-fg)' }
                  : runwaySeverity === 'warning'
                    ? { color: 'var(--severity-warning-fg)' }
                    : undefined
              }
            >
              {runwayDays}d runway
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            aria-label="Top up from faucet"
            onClick={onTopUp}
            disabled={actionsDisabled || capReached}
            data-testid="wallet-topup"
            className="self-start"
          >
            Top up from faucet (free)
          </Button>
          {topupCopy && (
            <span className={statAux} data-testid="wallet-topup-quota">
              {topupCopy}
            </span>
          )}
        </div>

        <Separator />

        {/* ── PASSWORD ──────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3" data-testid="wallet-section-password">
          <span className={sectionLabel}>Password</span>
          <span className="font-mono text-[12px] text-[var(--fg-dim)]">
            last rotated:{' '}
            {lastPasswordRotationAt ? (
              <time dateTime={lastPasswordRotationAt} className="text-[var(--fg-muted)]">
                {lastPasswordRotationAt}
              </time>
            ) : (
              <span className="text-[var(--fg-muted)]">never</span>
            )}
          </span>
          <Button
            variant="secondary"
            size="sm"
            aria-label="Change password"
            onClick={() => navigate('/operator/security')}
            data-testid="wallet-change-password"
            className="self-start"
          >
            Change password
          </Button>
        </div>
      </Card>
    </TooltipProvider>
  );
}
