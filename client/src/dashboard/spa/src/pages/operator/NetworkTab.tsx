import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Network, AlertTriangle, ExternalLink, Activity } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../api/client.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';

/**
 * /operator/network — RPC + chain config (§2.11).
 *
 * Chain is read-only; RPC URL is free-text with a one-click "use default"
 * restore. Save surfaces via sonner toast.
 */

interface BootstrapWithChain {
  chain?: 'base' | 'base-sepolia';
  rpcUrl?: string;
  defaultRpcUrl?: string;
}

export interface NetworkTabProps {
  onRestartPending?: () => void;
}

export function NetworkTab({
  onRestartPending = () => undefined,
}: NetworkTabProps = {}): JSX.Element {
  const { data } = useQuery<BootstrapWithChain>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap() as Promise<BootstrapWithChain>,
    refetchInterval: 1500,
  });

  const chain = data?.chain ?? 'base-sepolia';
  const rpcUrl = data?.rpcUrl ?? '';
  const defaultRpcUrl =
    data?.defaultRpcUrl ??
    (chain === 'base'
      ? 'https://mainnet.base.org'
      : 'https://base-sepolia-rpc.publicnode.com');

  return (
    <div data-testid="network-tab" className="flex flex-col gap-4">
      <NetworkSectionContent
        chain={chain}
        rpcUrl={rpcUrl}
        defaultRpcUrl={defaultRpcUrl}
        rpcHealthy={true}
        onRestartPending={onRestartPending}
      />
      <TaskPostsCard />
    </div>
  );
}

/** Read `error.code` set by jfetch from the daemon's 503 payload `error` field. */
function errorCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string') return code;
    if (error.message.includes('rpc_rate_limited')) return 'rpc_rate_limited';
    if (error.message.includes('discovery_unavailable')) return 'discovery_unavailable';
    if (error.message.includes('subsystem_not_ready')) return 'subsystem_not_ready';
  }
  return undefined;
}

/**
 * §2.11 Network — "Task posts" panel (#918). Chain-wide windowed count of
 * on-chain `TaskCreated` events (last 1h / 6h / 24h) on the active chain's
 * TaskCoordinator. Block-window approximation; counts are approximate.
 */
function TaskPostsCard(): JSX.Element {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['discovery', 'task-post-counts', 'chain'],
    queryFn: () => api.discovery.getTaskPostCounts(),
    refetchInterval: 30_000,
  });

  let body: JSX.Element;
  if (isError) {
    const code = errorCode(error);
    body =
      code === 'rpc_rate_limited' ? (
        <Alert variant="warning" data-error-code="rpc_rate_limited">
          <AlertTriangle className="h-4 w-4 text-[var(--wane)]" />
          <AlertTitle className="text-[var(--wane)]">RPC rate-limited</AlertTitle>
          <AlertDescription>
            Your RPC endpoint is rate-limited — add your own free key above to
            keep the task-post rate live.
          </AlertDescription>
        </Alert>
      ) : (
        <p className="font-mono text-[12px] text-[var(--fg-muted)]">
          Task-post rate is unavailable while the indexer catches up.
        </p>
      );
  } else if (isLoading || !data) {
    body = (
      <p className="font-mono text-[12px] text-[var(--fg-muted)]">Loading…</p>
    );
  } else if (data.chain.h24 === 0) {
    body = (
      <p className="font-mono text-[12px] text-[var(--fg-muted)]">
        No task posts in the last 24h.
      </p>
    );
  } else {
    body = (
      <div className="grid grid-cols-3 gap-4">
        {(
          [
            ['Last 1h', data.chain.h1],
            ['Last 6h', data.chain.h6],
            ['Last 24h', data.chain.h24],
          ] as const
        ).map(([label, count]) => (
          <div key={label} className="flex flex-col gap-1">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--fg-dim)]">
              {label}
            </span>
            <span className="font-mono text-[20px] text-foreground">{count}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <Card data-testid="network-task-posts">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-3.5 w-3.5" aria-hidden="true" />
          Task posts
        </CardTitle>
        <CardDescription>
          On-chain task posts on this network (approximate, block-windowed).
        </CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

interface NetworkSectionContentProps {
  chain: 'base' | 'base-sepolia';
  rpcUrl: string;
  defaultRpcUrl: string;
  rpcHealthy: boolean;
  onRestartPending: () => void;
}

function NetworkSectionContent({
  chain,
  rpcUrl,
  defaultRpcUrl,
  rpcHealthy,
  onRestartPending,
}: NetworkSectionContentProps): JSX.Element {
  const [draft, setDraft] = useState(rpcUrl);
  const [saving, setSaving] = useState(false);

  const dirty = draft !== rpcUrl;
  const onSharedDefault = rpcUrl === defaultRpcUrl;
  const chainLabel =
    chain === 'base' ? 'Base mainnet (chain id 8453)' : 'Base Sepolia (chain id 84532)';
  const chainShort = chainLabel.split(' (')[0];

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const next = draft.length === 0 ? null : draft;
      const res = await api.updateNetwork({ rpcUrl: next });
      toast.success('RPC URL saved', {
        description: res.restartRequired
          ? 'Restart pending — applies on next daemon start.'
          : 'Applied to the running daemon.',
      });
      if (res.restartRequired) onRestartPending();
    } catch (err) {
      toast.error('Failed to save RPC URL', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="flex items-center gap-2">
            <Network className="h-3.5 w-3.5" aria-hidden="true" />
            Network
          </CardTitle>
          <CardDescription>
            {chainShort} · {rpcUrl}
          </CardDescription>
        </div>
        <Badge variant={rpcHealthy ? 'success' : 'destructive'}>
          {rpcHealthy ? 'Healthy' : 'Unreachable'}
        </Badge>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label>Chain</Label>
            <div className="rounded-md border border-border bg-[var(--bg-sunken)] px-3 py-2 font-mono text-[13px] text-muted-foreground">
              {chainLabel}
            </div>
            <Badge variant="outline" className="self-start">
              locked
            </Badge>
            <p className="font-mono text-[11px] text-[var(--fg-dim)]">
              Switching chains resets fleet state — that's a separate flow.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="rpc-url">RPC URL</Label>
              {dirty && <Badge variant="warning">Restart</Badge>}
            </div>
            <Input
              id="rpc-url"
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={defaultRpcUrl}
              className={dirty ? 'border-primary' : undefined}
            />
            <Button
              variant="link"
              size="sm"
              type="button"
              onClick={() => setDraft('')}
              className="h-auto self-start p-0 text-[11px]"
            >
              Use default
            </Button>
            {onSharedDefault && (
              <Alert
                variant="warning"
                className="mt-3"
                data-testid="network-shared-rpc-warning"
              >
                <AlertTriangle className="h-4 w-4 text-[var(--wane)]" />
                <AlertTitle className="text-[var(--wane)]">Shared RPC</AlertTitle>
                <AlertDescription>
                  You're on the default RPC — a free public gateway shared with every
                  operator on the default config. Fine for setup; not reliable under
                  load. Get your own free key from{' '}
                  <a
                    href="https://dashboard.tenderly.co/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary hover:underline"
                  >
                    Tenderly <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                  ,{' '}
                  <a
                    href="https://www.alchemy.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary hover:underline"
                  >
                    Alchemy <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                  , or{' '}
                  <a
                    href="https://www.quicknode.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary hover:underline"
                  >
                    QuickNode <ExternalLink className="h-2.5 w-2.5" />
                  </a>{' '}
                  and paste it above.
                </AlertDescription>
              </Alert>
            )}
            <p className="font-mono text-[11px] text-[var(--fg-dim)]">
              Default: {defaultRpcUrl}
            </p>
          </div>
        </div>
        {dirty && (
          <div className="mt-6 flex items-center justify-end gap-2 border-t border-border pt-4">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => setDraft(rpcUrl)}
            >
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              type="button"
              disabled={saving}
              onClick={() => {
                void save();
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
