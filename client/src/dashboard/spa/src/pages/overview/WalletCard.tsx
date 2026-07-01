import { useLocation } from 'wouter';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Separator } from '../../components/ui/separator.js';
import { TooltipProvider } from '../../components/ui/tooltip.js';
import type { StakingRewardReadState } from '../../api/types.js';

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
  // perRole stays in the props so re-enabling the drill-down later is a
  // one-block restore. Real values are wired via #430; the drill-down rows
  // are commented out pending a follow-up Issue.
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  perRole?: {
    master: string;
    agent: string;
    safe: string;
  };
  /**
   * Lifetime stOLAS curating-agent rewards claimed via the distributor (wei
   * string formatted for display). Meaningful when `olasState === 'ready'`.
   */
  olasEarned: string;
  /**
   * Sum of distributor.claim reward_claims recorded in the last 24 hours,
   * formatted as a decimal string when available.
   */
  olasEarnedLast24h: string | null;
  /** Read state for the OLAS earned figures. */
  olasState: StakingRewardReadState;
  /** Public read error string when rewards are unavailable. */
  olasError?: string | null;
  // lastClaimAt stays in the props so re-enabling the "last claim" row is
  // a one-block restore.
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  lastClaimAt?: string | null;
  /** ISO timestamp of last password rotation, or null if never rotated */
  lastPasswordRotationAt: string | null;
  onTopUp: () => void;
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
 * Display value + supporting copy for the OLAS-earned row, keyed on the read
 * state.
 */
function olasDisplay(
  state: StakingRewardReadState,
  olasEarned: string,
  olasError: string | null | undefined,
): { value: string; copy: string | null } {
  switch (state) {
    case 'ready':
      return { value: olasEarned, copy: null };
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
  olasEarned,
  olasEarnedLast24h,
  olasState,
  olasError,
  lastPasswordRotationAt,
  onTopUp,
  actionsDisabled = false,
  topupDailyCap,
  topupCallsRemaining,
  topupCooldownExpiresAt,
}: WalletCardProps): JSX.Element {
  const [, navigate] = useLocation();
  const { value: olasValue, copy: olasStateCopy } = olasDisplay(
    olasState,
    olasEarned,
    olasError,
  );

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

          {/*
            24h-window claimed rewards is the operationally meaningful number.
            Lifetime (`rewards.claimedStakingRewardsWei`) is shown below.
          */}
          <div
            className="flex flex-col gap-1"
            data-testid="olas-earned-24h-region"
            aria-live="polite"
            aria-atomic="true"
          >
            <p className="text-sm font-medium text-muted-foreground">
              OLAS earned last 24hrs
            </p>
            <div className="flex items-baseline gap-2">
              <span
                className="text-2xl font-bold tracking-tight"
                data-testid="olas-earned-24h-value"
                style={olasState === 'error' ? { color: 'var(--break-red)' } : undefined}
              >
                {olasEarnedLast24h ?? (olasState === 'error' ? 'unavailable' : 'pending')}
              </span>
              {olasEarnedLast24h !== null && (
                <span className="text-xs text-muted-foreground">OLAS</span>
              )}
            </div>
          </div>

          <div
            className="flex flex-col gap-1"
            data-testid="olas-earned-region"
            aria-live="polite"
            aria-atomic="true"
          >
            <p className="text-xs text-muted-foreground" data-testid="olas-earned-state-prefix">
              Lifetime
            </p>
            <div className="flex items-baseline gap-2">
              <span
                className="text-base font-medium"
                data-testid="olas-earned-value"
                style={olasState === 'error' ? { color: 'var(--break-red)' } : undefined}
              >
                {olasValue}
              </span>
              {olasState === 'ready' && (
                <span className="text-xs text-muted-foreground">OLAS</span>
              )}
            </div>
            {olasStateCopy && (
              <span className="text-xs text-muted-foreground" data-testid="olas-earned-state">
                {olasStateCopy}
              </span>
            )}
          </div>
        </div>

        <Separator />

        {/* ── GAS ───────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3" data-testid="wallet-section-gas">
          <span className={sectionLabel}>Gas</span>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className={statBig}>{totalEth}</span>
            <span className={statUnit}>ETH</span>
            <span className={statAux}>·</span>
            <span className={statAux}>{runwayDays}d runway</span>
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
