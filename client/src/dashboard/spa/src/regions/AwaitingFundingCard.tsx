import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';

interface Props {
  address: string;
  minimumWei: string;
  chainExplorerBase: string;
  /** Daemon's configured chain (e.g. 'base' or 'base-sepolia'). Surfaced in
   *  the funding-card copy so the operator knows which network to send on. */
  chain?: string;
  /**
   * True when the daemon is running on the shared default RPC. Surfaces a
   * one-line BYO-RPC nudge in the first-run flow so the operator sees the
   * option before they bounce off a rate-limit failure later. See jinn-mono #325.
   */
  onSharedDefaultRpc?: boolean;
}

const CHAIN_DISPLAY_NAME: Record<string, string> = {
  base: 'Base',
  'base-sepolia': 'Base Sepolia',
};

export function AwaitingFundingCard({
  address,
  minimumWei,
  chainExplorerBase,
  chain,
  onSharedDefaultRpc = false,
}: Props): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [fundingStartedAt, setFundingStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // jinn-mono-u34i: once the operator clicks FUND FROM FAUCET, treat subsequent
  // funding gaps in this session as "operator already opted into faucet help"
  // and auto-continue drip sessions when a new gate appears (e.g. Stage 1 →
  // Stage 2). Without this, after the first session lands on the Stage 1 gate
  // the button gets stuck in "FAUCET FUNDED" disabled and the operator must
  // manually reload the panel to continue — violating the never-leave-the-app
  // principle.
  const hasOptedInRef = useRef(false);
  const [dripStatus, setDripStatus] = useState<
    | { state: 'idle' }
    | { state: 'requesting' }
    | {
        state: 'sent';
        txHash?: string;
        txHashes?: string[];
        attempts?: number;
        balanceWei?: string;
        targetWei?: string;
      }
    | { state: 'rate_limited'; reason: string }
    | { state: 'failed'; reason: string }
  >({ state: 'idle' });

  useEffect(() => {
    if (fundingStartedAt === null) return undefined;
    setElapsedSeconds(Math.max(0, Math.floor((Date.now() - fundingStartedAt) / 1000)));
    const id = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - fundingStartedAt) / 1000)));
    }, 1_000);
    return () => window.clearInterval(id);
  }, [fundingStartedAt]);

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const requestDrip = async (): Promise<void> => {
    hasOptedInRef.current = true;
    setFundingStartedAt(Date.now());
    setElapsedSeconds(0);
    setDripStatus({ state: 'requesting' });
    try {
      const r = await api.triggerDrip();
      setFundingStartedAt(null);
      if (r.ok) {
        setDripStatus({
          state: 'sent',
          txHash: r.txHash ?? r.txHashes?.at(-1),
          txHashes: r.txHashes,
          attempts: r.attempts,
          balanceWei: r.balanceWei,
          targetWei: r.targetWei,
        });
      } else if (r.rateLimited || (r.reason && /rate|claimed|429/i.test(r.reason))) {
        setDripStatus({ state: 'rate_limited', reason: r.reason ?? 'faucet rate-limited' });
      } else {
        setDripStatus({ state: 'failed', reason: r.reason ?? 'faucet funding failed' });
      }
    } catch (err) {
      setFundingStartedAt(null);
      setDripStatus({
        state: 'failed',
        reason: err instanceof Error ? err.message : 'drip failed',
      });
    }
  };

  // jinn-mono-u34i: when the daemon advances to a new gate (Stage 1 → Stage 2,
  // etc.) the panel re-renders with a new `minimumWei`. The local dripStatus is
  // still 'sent' from the prior session and the button stays disabled, leaving
  // the operator stuck. Reset the session on any minimumWei change; if the
  // operator already opted into faucet help, auto-fire the next drip.
  const lastMinimumRef = useRef<string>(minimumWei);
  useEffect(() => {
    if (lastMinimumRef.current === minimumWei) return;
    lastMinimumRef.current = minimumWei;
    setDripStatus({ state: 'idle' });
    if (hasOptedInRef.current) {
      void requestDrip();
    }
  }, [minimumWei]);

  const formatEth = (wei?: string): string => {
    if (!wei) return 'unknown';
    try {
      const eth = Number(BigInt(wei)) / 1e18;
      return `${eth.toFixed(eth < 0.001 ? 4 : 3)} ETH`;
    } catch {
      return `${wei} wei`;
    }
  };

  const minimumEth = formatEth(minimumWei);
  const fundingProgress = useMemo(() => {
    if (dripStatus.state !== 'requesting') return 0;
    // The Base Sepolia CDP faucet sends tiny drips and may require many calls.
    // This is a time-based progress cue; the precise drip count arrives in the response.
    return Math.min(92, Math.max(8, Math.round((elapsedSeconds / 60) * 92)));
  }, [dripStatus.state, elapsedSeconds]);

  const sentTxCount =
    dripStatus.state === 'sent'
      ? dripStatus.txHashes?.length ?? dripStatus.attempts ?? (dripStatus.txHash ? 1 : 0)
      : 0;

  // The /v1/setup/drip endpoint returns ok:true whenever any drips landed,
  // even if the balance is still under target. Treat 'sent' as terminal only
  // when the balance has actually cleared the target — otherwise let the user
  // click again to top up the gap.
  const targetReached =
    dripStatus.state === 'sent' &&
    dripStatus.balanceWei !== undefined &&
    dripStatus.targetWei !== undefined &&
    (() => {
      try {
        return BigInt(dripStatus.balanceWei!) >= BigInt(dripStatus.targetWei!);
      } catch {
        return false;
      }
    })();
  const partialDrip = dripStatus.state === 'sent' && !targetReached;

  return (
    <div
      className="px-6 py-5 flex flex-col gap-4"
      style={{
        border: '1px solid var(--accent-gold)',
        background: 'rgba(220, 184, 102, 0.04)',
        borderRadius: 'var(--radius-2)',
      }}
    >
      <div className="flex items-baseline justify-between">
        <span className="j-label" style={{ color: 'var(--accent-gold)' }}>
          Action needed · fund the master EOA
        </span>
        <span className="j-mono text-[10px]" style={{ color: 'var(--fg-dim)' }}>
          auto-detected on chain
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="j-mono text-xs break-all" style={{ color: 'var(--fg)' }}>
          {address}
        </span>
        <span className="j-mono text-xs" style={{ color: 'var(--fg-muted)' }}>
          send at least {minimumEth} on {CHAIN_DISPLAY_NAME[chain ?? ''] ?? 'this chain'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={requestDrip}
          type="button"
          disabled={dripStatus.state === 'requesting' || targetReached}
          className="px-3 py-1.5 j-label hover:opacity-90 disabled:opacity-50"
          style={{
            background: 'var(--accent-gold)',
            color: 'var(--bg)',
            borderRadius: 'var(--radius-1)',
          }}
        >
          {dripStatus.state === 'requesting'
            ? 'Funding...'
            : targetReached
              ? 'Faucet funded'
              : partialDrip
                ? 'Fund more'
                : 'Fund from faucet'}
        </button>
        <button
          onClick={copy}
          type="button"
          className="px-3 py-1.5 j-label hover:opacity-90"
          style={{
            border: '1px solid var(--border-strong)',
            color: 'var(--fg)',
            borderRadius: 'var(--radius-1)',
            background: 'transparent',
          }}
        >
          {copied ? 'Copied' : 'Copy address'}
        </button>
        <a
          href={`${chainExplorerBase}/address/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1.5 j-label hover:opacity-90"
          style={{
            border: '1px solid var(--border)',
            color: 'var(--fg-muted)',
            borderRadius: 'var(--radius-1)',
          }}
        >
          View on explorer
        </a>
      </div>
      {dripStatus.state === 'sent' && (
        <p
          className="j-mono text-[11px]"
          style={{ color: targetReached ? 'var(--vow-green)' : 'var(--accent-gold)' }}
        >
          {targetReached ? 'Faucet funding complete' : 'Faucet funding partial'}
          {sentTxCount > 0 ? ` (${sentTxCount} drip${sentTxCount === 1 ? '' : 's'})` : ''}.
          {dripStatus.balanceWei && dripStatus.targetWei
            ? ` Balance ${formatEth(dripStatus.balanceWei)} / target ${formatEth(dripStatus.targetWei)}.`
            : ''}
          {partialDrip ? ' Click "Fund more" to top up.' : ''}
          {dripStatus.txHash && (
            <>
              {' '}
              <a
                href={`${chainExplorerBase}/tx/${dripStatus.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
                style={{ color: 'var(--accent-sky)' }}
              >
                view latest tx
              </a>
            </>
          )}
        </p>
      )}
      {dripStatus.state === 'requesting' && (
        <div className="flex flex-col gap-2">
          <div
            className="h-1.5 overflow-hidden"
            style={{ background: 'var(--bg-sunken)', borderRadius: '999px' }}
          >
            <div
              className="h-full transition-all"
              style={{
                width: `${fundingProgress}%`,
                background: 'var(--accent-gold)',
                borderRadius: '999px',
              }}
            />
          </div>
          <p className="j-mono text-[11px]" style={{ color: 'var(--fg-muted)' }}>
            Requesting faucet drips for {trunc(address)}. Elapsed {elapsedSeconds}s; this can take about a
            minute on a fresh wallet.
          </p>
        </div>
      )}
      {dripStatus.state === 'rate_limited' && (
        <p className="j-mono text-[11px]" style={{ color: 'var(--wane)' }}>
          Faucet rate-limited. Send manually or wait before trying again.
        </p>
      )}
      {dripStatus.state === 'failed' && (
        <p className="j-mono text-[11px]" style={{ color: 'var(--break-red)' }}>
          {dripStatus.reason}
        </p>
      )}
      {onSharedDefaultRpc && (
        <p
          data-testid="onboarding-shared-rpc-nudge"
          className="j-mono text-[11px]"
          style={{ color: 'var(--fg-dim)' }}
        >
          Using a shared trial RPC — add your own key in Settings &gt; Network
          for reliable operation.
        </p>
      )}
    </div>
  );
}

const trunc = (s: string): string => `${s.slice(0, 6)}…${s.slice(-4)}`;
