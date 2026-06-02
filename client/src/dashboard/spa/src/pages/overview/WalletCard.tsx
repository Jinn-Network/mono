import { useLocation } from 'wouter';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Separator } from '../../components/ui/separator.js';
import { TooltipProvider } from '../../components/ui/tooltip.js';
import type { TjinnStatusState } from '../../api/types.js';

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
   * Real Sepolia tJINN ERC-20 Safe balance, formatted as a decimal string
   * (#406). Only meaningful when `tjinnState === 'ready'`; `pending`/`error`
   * render state copy from `tjinnDisplay` instead.
   */
  tjinnEarned: string;
  /**
   * Sum of `JinnDistributor.Claimed.operatorMinted` for the operator's
   * services over the last 24 hours, formatted as a decimal string when
   * available. Null while pending or on read error.
   */
  tjinnEarnedLast24h: string | null;
  /** Read state for the Sepolia tJINN balance. */
  tjinnState: TjinnStatusState;
  /** Public read error string, if the Sepolia balance is unavailable. */
  tjinnError?: string | null;
  // lastClaimAt stays in the props so re-enabling the "last claim" row is
  // a one-block restore.
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  lastClaimAt?: string | null;
  /** ISO timestamp of last password rotation, or null if never rotated */
  lastPasswordRotationAt: string | null;
  onTopUp: () => void;
  /** When true, action buttons are disabled (e.g. another action is in flight). */
  actionsDisabled?: boolean;
}

const eyebrow = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-muted)]';
const sectionLabel = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]';
const statBig = 'font-mono text-[24px] font-medium tracking-[-0.01em] text-foreground';
const statUnit = 'font-mono text-[12px] font-medium text-[var(--fg-muted)]';
const statAux = 'font-mono text-[12px] text-[var(--fg-dim)]';

/**
 * Display value + supporting copy for the tJINN-earned row, keyed on the read
 * state. A single lookup keeps `value` and `copy` in lockstep — `ready` shows
 * the formatted balance with no copy; `pending`/`error` show placeholder copy
 * instead of a misleading bare zero while the Sepolia read is unresolved.
 */
function tjinnDisplay(
  state: TjinnStatusState,
  tjinnEarned: string,
  tjinnError: string | null | undefined,
): { value: string; copy: string | null } {
  switch (state) {
    case 'ready':
      return { value: tjinnEarned, copy: null };
    case 'error':
      return {
        value: 'unavailable',
        copy: tjinnError ?? 'Sepolia tJINN balance temporarily unavailable.',
      };
    case 'pending':
      return { value: 'pending', copy: 'Waiting for Sepolia balance.' };
  }
}

export function WalletCard({
  totalEth,
  runwayDays,
  tjinnEarned,
  tjinnEarnedLast24h,
  tjinnState,
  tjinnError,
  lastPasswordRotationAt,
  onTopUp,
  actionsDisabled = false,
}: WalletCardProps): JSX.Element {
  const [, navigate] = useLocation();
  const { value: tjinnValue, copy: tjinnStateCopy } = tjinnDisplay(
    tjinnState,
    tjinnEarned,
    tjinnError,
  );

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
            24h-window minted is the operationally meaningful number — it's
            what the operator earned today. Lifetime (`tJinn.safeBalanceWei`)
            is a supporting reference shown below in smaller type.
          */}
          <div
            className="flex flex-col gap-1"
            data-testid="tjinn-earned-24h-region"
            aria-live="polite"
            aria-atomic="true"
          >
            <p className="text-sm font-medium text-muted-foreground">
              JINN earned last 24hrs
            </p>
            <div className="flex items-baseline gap-2">
              <span
                className="text-2xl font-bold tracking-tight"
                data-testid="tjinn-earned-24h-value"
                style={tjinnState === 'error' ? { color: 'var(--break-red)' } : undefined}
              >
                {tjinnEarnedLast24h ?? (tjinnState === 'error' ? 'unavailable' : 'pending')}
              </span>
              {tjinnEarnedLast24h !== null && (
                <span className="text-xs text-muted-foreground">tJINN</span>
              )}
            </div>
          </div>

          {/* Lifetime tJINN ERC-20 Safe balance (#406), minted by JinnDistributor. */}
          <div
            className="flex flex-col gap-1"
            data-testid="tjinn-earned-region"
            aria-live="polite"
            aria-atomic="true"
          >
            <p className="text-xs text-muted-foreground" data-testid="tjinn-earned-state-prefix">
              Lifetime
            </p>
            <div className="flex items-baseline gap-2">
              <span
                className="text-base font-medium"
                data-testid="tjinn-earned-value"
                style={tjinnState === 'error' ? { color: 'var(--break-red)' } : undefined}
              >
                {tjinnValue}
              </span>
              {tjinnState === 'ready' && (
                <span className="text-xs text-muted-foreground">tJINN</span>
              )}
            </div>
            {tjinnStateCopy && (
              <span className="text-xs text-muted-foreground" data-testid="tjinn-earned-state">
                {tjinnStateCopy}
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
            disabled={actionsDisabled}
            data-testid="wallet-topup"
            className="self-start"
          >
            Top up from faucet (free)
          </Button>
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
