import { type ReactNode, useCallback, useState, type JSX } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '../../api/client.js';
import type { BootstrapErrorEnvelope } from '../../../../../api/contract/index.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';

/**
 * Blocking error card shown beneath the active phase row when the
 * bootstrapper has halted. Surfaces the structured envelope (category,
 * insufficient-funds breakdown, transaction link, recovery hint) and
 * exposes a Retry button that re-runs the bootstrapper. Pulled out of the
 * parent Onboarding region as part of the C.7 shadcn split.
 */
export function BootstrapErrorCard({
  envelope,
  chainExplorerBase,
}: {
  envelope: BootstrapErrorEnvelope;
  chainExplorerBase: string;
}): JSX.Element {
  const txHash = extractTxHash(envelope);
  const generatedAt = formatRelativeTime(envelope.generatedAt);
  const [retryState, setRetryState] = useState<'idle' | 'retrying' | 'success' | 'error'>('idle');
  const [retryError, setRetryError] = useState<string | null>(null);

  const details = envelope.details as Record<string, unknown> | undefined;
  const category = typeof details?.['category'] === 'string' ? details['category'] : undefined;
  const isInsufficientFunds = category === 'insufficient_funds';
  const fundingAddress = typeof details?.['address'] === 'string' ? details['address'] : null;
  const requiredWei =
    typeof details?.['requiredWei'] === 'string'
      ? details['requiredWei']
      : typeof details?.['needWei'] === 'string'
        ? details['needWei']
        : null;
  const haveWei = typeof details?.['haveWei'] === 'string' ? details['haveWei'] : null;
  const txHashFromDetails = typeof details?.['txHash'] === 'string' ? details['txHash'] : null;
  const resolvedTxHash = txHashFromDetails ?? txHash;

  const handleRetry = useCallback(async () => {
    setRetryState('retrying');
    setRetryError(null);
    try {
      await api.retryBootstrap();
      setRetryState('success');
    } catch (err) {
      setRetryState('error');
      setRetryError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <Alert variant="blocking" className="flex flex-col gap-3 px-5 py-4">
      <div className="flex items-baseline justify-between">
        <AlertTitle className="text-[var(--break-red)]">
          Bootstrap halted · {envelope.code}
        </AlertTitle>
        {generatedAt && (
          <span className="font-mono text-[10px] text-[var(--fg-dim)]">{generatedAt}</span>
        )}
      </div>
      <AlertDescription className="break-words font-mono text-xs text-foreground">
        {envelope.message}
      </AlertDescription>
      {isInsufficientFunds && fundingAddress && (
        <div className="flex flex-col gap-1">
          <ErrorDetailRow label="Send ETH to">{fundingAddress}</ErrorDetailRow>
          {requiredWei && (
            <ErrorDetailRow label="Required">{formatWeiAsEth(requiredWei)}</ErrorDetailRow>
          )}
          {haveWei && (
            <ErrorDetailRow label="Currently have">{formatWeiAsEth(haveWei)}</ErrorDetailRow>
          )}
          {requiredWei && haveWei && (
            <ErrorDetailRow label="Shortfall">
              {formatWeiAsEth((BigInt(requiredWei) - BigInt(haveWei)).toString())}
            </ErrorDetailRow>
          )}
        </div>
      )}
      {!isInsufficientFunds && envelope.hint && (
        <p className="font-mono text-xs text-[var(--fg-muted)]">
          <span className="text-[var(--fg-dim)]">Fix · </span>
          {envelope.hint}
        </p>
      )}
      {resolvedTxHash && (
        <Button asChild variant="link" size="sm" className="self-start px-0">
          <a
            href={`${chainExplorerBase}/tx/${resolvedTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            view failed tx
            <ExternalLink />
          </a>
        </Button>
      )}
      <div className="mt-1 flex items-center gap-3">
        <Button
          variant="destructive"
          size="sm"
          type="button"
          onClick={() => {
            void handleRetry();
          }}
          disabled={retryState === 'retrying'}
        >
          {retryState === 'retrying'
            ? 'Retrying…'
            : retryState === 'success'
              ? 'Resuming…'
              : 'Retry'}
        </Button>
        {retryState === 'success' && (
          <span className="font-mono text-[11px] text-[var(--fg-muted)]">
            Daemon resumed — waiting for bootstrap to complete
          </span>
        )}
        {retryState === 'error' && retryError && (
          <span className="font-mono text-[11px] text-[var(--break-red)]">{retryError}</span>
        )}
      </div>
      {retryState === 'idle' && (
        <p className="font-mono text-[11px] text-[var(--fg-dim)]">
          Once you've addressed the cause above, click Retry or{' '}
          <code className="text-[var(--fg-muted)]">jinn run</code> to resume from the persisted
          state.
        </p>
      )}
    </Alert>
  );
}

function ErrorDetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <span className="min-w-[100px] shrink-0 font-mono text-[11px] text-[var(--fg-dim)]">
        {label}
      </span>
      <span className="break-all font-mono text-[11px] text-foreground">{children}</span>
    </div>
  );
}

function formatWeiAsEth(wei: string): string {
  try {
    const n = BigInt(wei);
    // Show as ETH with up to 6 decimal places
    const eth = Number(n) / 1e18;
    if (eth === 0) return '0 ETH';
    if (eth < 0.000001) return `${n} wei`;
    return `${eth.toFixed(6).replace(/\.?0+$/, '')} ETH`;
  } catch {
    return wei;
  }
}

function extractTxHash(envelope: BootstrapErrorEnvelope): string | null {
  const candidates: unknown[] = [
    envelope.details?.['txHash'],
    envelope.details?.['cause'],
    envelope.message,
  ];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const m = /(0x[a-fA-F0-9]{64})/.exec(c);
    if (m) return m[1];
  }
  return null;
}

function formatRelativeTime(iso: string): string | null {
  try {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return null;
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    return `${hr}h ago`;
  } catch {
    return null;
  }
}
