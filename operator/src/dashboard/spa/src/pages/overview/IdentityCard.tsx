import { useState, type ReactNode, type JSX } from 'react';
import { api } from '../../api/client.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import type { ServiceIdentity } from './WalletCard.js';

/**
 * Identity — the operator's on-chain identities per OPERATOR-APP-SPEC §2.2.
 * Five labelled monospace stats (Service / Agent / Master / Safe — agent
 * EOA reserved for a future daemon field) plus the binding-pending retry
 * flow and three §2.2 state-message rows.
 */
export interface IdentityCardProps {
  masterAddress: string | null;
  agentAddress: string | null;
  safeAddress: string | null;
  serviceId: number | null;
  agentId: number | null;
  services?: ServiceIdentity[];
  bindingError?: string;
}

const eyebrow = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-muted)]';
const sectionLabel = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]';
const statValue = 'font-mono text-[14px] text-foreground';
const emptyValue = 'font-mono text-[14px] text-[var(--fg-muted)]';

function trunc(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function EmptyDash(): JSX.Element {
  return <span data-testid="identity-stat-empty" className={emptyValue}>—</span>;
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy path below.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    if (document.execCommand('copy') !== true) {
      throw new Error('Copy command failed');
    }
  } finally {
    textarea.remove();
  }
}

function Stat({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className={sectionLabel}>{label}</span>
      {children}
    </div>
  );
}

function AddressStat({ label, address, testId }: {
  label: string;
  address: string | null;
  testId: string;
}): JSX.Element {
  const copy = (): void => {
    if (!address) return;
    void copyToClipboard(address).catch(() => {});
  };

  return (
    <Stat label={label}>
      {address ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid={testId}
              aria-label={`Copy full ${label} address`}
              onClick={copy}
              className={`cursor-copy border-0 bg-transparent p-0 text-left ${statValue}`}
            >
              {trunc(address)}
            </button>
          </TooltipTrigger>
          <TooltipContent>{address}</TooltipContent>
        </Tooltip>
      ) : (
        <EmptyDash />
      )}
    </Stat>
  );
}

export function IdentityCard({
  masterAddress,
  safeAddress,
  serviceId,
  agentId,
  services = [],
  bindingError,
}: IdentityCardProps): JSX.Element {
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
        aria-label="Identity"
        data-testid="identity-card"
        className="flex flex-col gap-6 p-6"
      >
        <span className={eyebrow}>Identity</span>

        <div className="flex flex-wrap gap-8">
          <Stat label="Service">
            {serviceId !== null ? (
              <span data-testid="identity-service-id" className={statValue}>#{serviceId}</span>
            ) : (
              <EmptyDash />
            )}
          </Stat>
          <Stat label="Agent">
            <span className={`flex items-center gap-2 ${statValue}`}>
              {agentId !== null ? `#${agentId}` : <EmptyDash />}
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
          </Stat>
          <AddressStat label="Master" address={masterAddress} testId="identity-master-address" />
          <AddressStat label="Safe" address={safeAddress} testId="identity-safe-address" />
        </div>

        {pendingBinding && (
          <Alert
            variant="warning"
            data-testid="identity-state-message-safe-not-bound"
            className="flex flex-col gap-2"
          >
            <AlertDescription>
              Service #{pendingBinding.index} Safe is not yet bound to agent #{pendingBinding.agentId}.
              The bootstrap left it unbound; retry to attempt the ERC-1271 bind again.
            </AlertDescription>
            {bindingOpen && retryDetail && (
              <span className="font-mono text-[11px] text-[var(--break-red)]">{retryDetail}</span>
            )}
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                if (!bindingOpen) setBindingOpen(true);
                void retry();
              }}
              disabled={retrying}
              className="self-start"
            >
              {retrying ? 'Retrying…' : 'Retry binding'}
            </Button>
          </Alert>
        )}

        {agentId === null && (
          <Alert
            variant="warning"
            data-testid="identity-state-message-agent-id-not-minted"
          >
            <AlertDescription>
              Agent ID has not yet been minted. The daemon mints it during bootstrap; if this
              persists, check the bootstrap logs.
            </AlertDescription>
          </Alert>
        )}
      </Card>
    </TooltipProvider>
  );
}
