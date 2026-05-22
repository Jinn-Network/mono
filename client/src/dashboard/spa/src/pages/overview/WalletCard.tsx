import { useState } from 'react';
import { useLocation } from 'wouter';
import { api } from '../../api/client.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Separator } from '../../components/ui/separator.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import type { TjinnStatusState } from '../../api/types.js';

/**
 * Wallet — single consolidated card on /overview that absorbed the
 * separate Funds, Rewards, and Identity cards plus the password-rotation
 * row. Four hairline-separated sections, all "small text" stats below
 * eyebrows so the card reads as one surface rather than four neighbours.
 *
 * Migrated to shadcn primitives (Card, Button, Badge, Separator, Tooltip,
 * Alert). Truncated addresses now ship a Tooltip with the full value
 * instead of the legacy `title=` attribute.
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
  /** OLAS-style staking collector queue, formatted as decimal string. */
  claimableJinn: string;
  /** OLAS-style staking collector claims submitted lifetime, formatted as decimal string. */
  claimedJinnLifetime: string;
  /**
   * Real Sepolia tJINN ERC-20 Safe balance, formatted as a decimal string
   * (#406). Only meaningful when `tjinnState === 'ready'`; `pending`/`error`
   * render state copy from `tjinnDisplay` instead.
   */
  tjinnEarned: string;
  /** Read state for the Sepolia tJINN balance. */
  tjinnState: TjinnStatusState;
  /** Public read error string, if the Sepolia balance is unavailable. */
  tjinnError?: string | null;
  // lastClaimAt stays in the props so re-enabling the "last claim" row is
  // a one-block restore.
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  lastClaimAt?: string | null;
  /** Operator's master EOA. */
  masterAddress: string | null;
  agentId: number | null;
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

const eyebrow = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-muted)]';
const sectionLabel = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]';
const statBig = 'font-mono text-[24px] font-medium tracking-[-0.01em] text-foreground';
const statUnit = 'font-mono text-[12px] font-medium text-[var(--fg-muted)]';
const statAux = 'font-mono text-[12px] text-[var(--fg-dim)]';

function trunc(addr: string | null | undefined): string {
  if (!addr || addr.length < 10) return addr ?? '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

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
  claimableJinn,
  claimedJinnLifetime,
  tjinnEarned,
  tjinnState,
  tjinnError,
  agentId,
  masterAddress,
  safeAddress,
  services = [],
  bindingError,
  lastPasswordRotationAt,
  onTopUp,
  onClaim,
  actionsDisabled = false,
}: WalletCardProps): JSX.Element {
  const [, navigate] = useLocation();
  const canClaimCollector = parseFloat(claimableJinn) > 0;
  const { value: tjinnValue, copy: tjinnStateCopy } = tjinnDisplay(
    tjinnState,
    tjinnEarned,
    tjinnError,
  );

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
    <TooltipProvider delayDuration={150}>
      <Card
        role="region"
        aria-label="Wallet"
        data-testid="wallet-card"
        className="flex flex-col gap-6 p-6"
      >
        <span className={eyebrow}>Wallet</span>

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

        {/* ── REWARDS ───────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3" data-testid="wallet-section-rewards">
          <span className={sectionLabel}>Rewards</span>

          {/*
            tJINN earned — the real Sepolia tJINN ERC-20 Safe balance (#406).
            This is the operator reward minted by JinnDistributor. The collector
            rows below are the OLAS-style staking maintenance path and are not
            spendable operator tJINN.
          */}
          <div
            className="flex flex-col gap-1"
            data-testid="tjinn-earned-region"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className={sectionLabel}>Testnet JINN earned</span>
            <div className="flex items-baseline gap-2">
              <span
                className={statBig}
                data-testid="tjinn-earned-value"
                style={tjinnState === 'error' ? { color: 'var(--break-red)' } : undefined}
              >
                {tjinnValue}
              </span>
              {tjinnState === 'ready' && <span className={statUnit}>tJINN</span>}
            </div>
            {tjinnStateCopy && (
              <span className={statAux} data-testid="tjinn-earned-state">
                {tjinnStateCopy}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <span className={sectionLabel}>Collector pending</span>
            <div className="flex items-baseline gap-2">
              <span className={statBig}>{claimableJinn}</span>
              <span className={statUnit}>collector-token</span>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className={sectionLabel}>Collector claimed</span>
            <div className="flex items-baseline gap-2">
              <span className={statBig}>{claimedJinnLifetime}</span>
              <span className={statUnit}>collector-token</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-label="Claim staking collector rewards"
              onClick={onClaim}
              disabled={!canClaimCollector || actionsDisabled}
              data-testid="wallet-claim"
              className="mt-2 self-start"
            >
              Claim collector
            </Button>
          </div>
        </div>

        <Separator />

        {/* ── IDENTITY ──────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3" data-testid="wallet-section-identity">
          <span className={sectionLabel}>Identity</span>
          <div className="flex flex-wrap gap-8">
            <div className="flex flex-col gap-1">
              <span className={sectionLabel}>Agent</span>
              <span className="flex items-center gap-2 font-mono text-[14px] text-foreground">
                {agentId !== null ? `#${agentId}` : '—'}
                {pendingBinding && (
                  <button
                    type="button"
                    onClick={() => setBindingOpen((o) => !o)}
                    className="cursor-pointer rounded-full border border-[var(--wane)] bg-transparent px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--wane)]"
                  >
                    binding pending
                  </button>
                )}
                {retryResult === 'success' && (
                  <Badge variant="success" className="rounded-full normal-case tracking-[0.12em]">
                    bound
                  </Badge>
                )}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className={sectionLabel}>Master</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    data-testid="wallet-master-address"
                    tabIndex={0}
                    className="cursor-help font-mono text-[14px] text-foreground"
                  >
                    {trunc(masterAddress)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{masterAddress ?? 'No master address yet'}</TooltipContent>
              </Tooltip>
            </div>
            <div className="flex flex-col gap-1">
              <span className={sectionLabel}>Safe</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="cursor-help font-mono text-[14px] text-foreground">
                    {trunc(safeAddress)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{safeAddress ?? 'No safe address yet'}</TooltipContent>
              </Tooltip>
            </div>
          </div>
          {bindingOpen && pendingBinding && (
            <Alert variant="warning" className="mt-2 flex flex-col gap-2">
              <AlertDescription>
                Service #{pendingBinding.index} Safe is not yet bound to agent #{pendingBinding.agentId}.
                The bootstrap left it unbound; retry to attempt the ERC-1271 bind again.
              </AlertDescription>
              {retryDetail && (
                <span className="font-mono text-[11px] text-[var(--break-red)]">{retryDetail}</span>
              )}
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  void retry();
                }}
                disabled={retrying}
                className="self-start"
              >
                {retrying ? 'Retrying…' : 'Retry binding'}
              </Button>
            </Alert>
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
