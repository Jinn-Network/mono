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
import type { RpcSlotHealth } from '../../../../../api/contract/index.js';

/**
 * /operator/network — RPC fallback chain + chain config (§2.11).
 *
 * Chain is read-only. The full shipped public RPC fallback chain renders as an
 * ordered, read-only slot list with per-slot boot-probe health; a single
 * Primary RPC input prepends to the runtime chain. Save surfaces via toast.
 */

interface BootstrapWithChain {
  chain?: 'base' | 'base-sepolia';
  rpcUrls?: string[];
  publicDefaults?: string[];
  rpcSlotHealth?: RpcSlotHealth[];
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
  const publicDefaults = data?.publicDefaults ?? [];
  const rpcUrls = data?.rpcUrls ?? publicDefaults;
  const slotHealth = data?.rpcSlotHealth ?? [];

  return (
    <div data-testid="network-tab" className="flex flex-col gap-4">
      <NetworkSectionContent
        // Re-seed the Primary RPC draft when the persisted chain changes
        // (e.g. when the query first resolves, or after a save + restart).
        // The array is identical across steady refetches, so in-progress
        // typing within a stable chain is never disturbed.
        key={rpcUrls.join(',')}
        chain={chain}
        rpcUrls={rpcUrls}
        publicDefaults={publicDefaults}
        slotHealth={slotHealth}
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
  } else if (!data.chain) {
    // Defensive: a non-error response missing `chain` (malformed/partial)
    // must degrade gracefully, not throw on `data.chain.h24` (#962-smoke).
    body = (
      <p className="font-mono text-[12px] text-[var(--fg-muted)]">
        Task-post rate is unavailable while the indexer catches up.
      </p>
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
  rpcUrls: string[];
  publicDefaults: string[];
  slotHealth: RpcSlotHealth[];
  onRestartPending: () => void;
}

/** Mask an RPC URL to its hostname so paths / api-key segments never render. */
function maskHost(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** True when slot 0 is operator-provided (i.e. not the first public default). */
function hasPrimary(rpcUrls: string[], publicDefaults: string[]): boolean {
  if (rpcUrls.length === 0) return false;
  return rpcUrls[0] !== publicDefaults[0];
}

function SlotHealthBadge({ health }: { health?: RpcSlotHealth }): JSX.Element {
  if (!health) {
    return <Badge variant="outline">unknown</Badge>;
  }
  if (health.ok) {
    return (
      <Badge variant="success">
        {health.localDev ? 'local dev' : 'healthy'}
        {health.latencyMs !== undefined ? ` · ${health.latencyMs}ms` : ''}
      </Badge>
    );
  }
  if (health.reason === 'chain_mismatch') {
    const detail =
      health.actualChainId !== undefined && health.expectedChainId !== undefined
        ? ` · ${health.actualChainId}/${health.expectedChainId}`
        : '';
    return <Badge variant="destructive">wrong chain{detail}</Badge>;
  }
  return (
    <Badge variant={health.code === 429 ? 'warning' : 'destructive'}>
      {health.code !== undefined ? `degraded · ${health.code}` : 'unreachable'}
    </Badge>
  );
}

function NetworkSectionContent({
  chain,
  rpcUrls,
  publicDefaults,
  slotHealth,
  onRestartPending,
}: NetworkSectionContentProps): JSX.Element {
  const primaryConfigured = hasPrimary(rpcUrls, publicDefaults);
  const currentPrimary = primaryConfigured ? rpcUrls[0]! : '';
  const [draft, setDraft] = useState(currentPrimary);
  const [saving, setSaving] = useState(false);

  const dirty = draft.trim() !== currentPrimary;
  const chainLabel =
    chain === 'base' ? 'Base mainnet (chain id 8453)' : 'Base Sepolia (chain id 84532)';
  const chainShort = chainLabel.split(' (')[0];

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const next = draft.trim().length === 0 ? null : draft.trim();
      const res = await api.updateNetwork({ rpcUrl: next });
      toast.success(next ? 'Primary RPC saved' : 'Primary RPC cleared', {
        description: res.restartRequired
          ? 'Restart pending — applies on next daemon start.'
          : 'Applied to the running daemon.',
      });
      if (res.restartRequired) onRestartPending();
    } catch (err) {
      toast.error('Failed to save Primary RPC', {
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
            {chainShort} · {rpcUrls.length} RPC slot{rpcUrls.length === 1 ? '' : 's'}
          </CardDescription>
        </div>
        <Badge variant="outline">locked</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Chain (read-only) */}
        <div className="flex flex-col gap-2">
          <Label>Chain</Label>
          <div className="rounded-md border border-border bg-[var(--bg-sunken)] px-3 py-2 font-mono text-[13px] text-muted-foreground">
            {chainLabel}
          </div>
          <p className="font-mono text-[11px] text-[var(--fg-dim)]">
            Switching chains resets fleet state — that's a separate flow.
          </p>
        </div>

        {/* Primary RPC slot (editable) */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="primary-rpc">Primary RPC</Label>
            {dirty && <Badge variant="warning">Restart</Badge>}
          </div>
          <Input
            id="primary-rpc"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="https://your-key.example (optional)"
            className={dirty ? 'border-primary' : undefined}
          />
          <p className="font-mono text-[11px] text-[var(--fg-dim)]">
            Tried first — falls back to public chain on failure.
          </p>
          {!primaryConfigured && (
            <p className="font-mono text-[11px] text-[var(--fg-dim)]">
              You're on the shared public chain — fine for setup, not reliable
              under load. Get your own free key from{' '}
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
            </p>
          )}
          {dirty && (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setDraft(currentPrimary)}
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
                {saving ? 'Saving…' : currentPrimary && draft.trim().length === 0 ? 'Clear' : 'Save'}
              </Button>
            </div>
          )}
        </div>

        {/* Full fallback chain (read-only, ordered) */}
        <div className="flex flex-col gap-2">
          <Label>RPC fallback chain</Label>
          <div
            data-testid="network-rpc-slots"
            className="flex flex-col divide-y divide-border rounded-md border border-border"
          >
            {rpcUrls.map((url, i) => (
              <div
                key={`${i}-${url}`}
                data-testid="network-rpc-slot"
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-[11px] text-[var(--fg-dim)]">
                    slot {i}
                  </span>
                  <span className="truncate font-mono text-[12px] text-foreground">
                    {maskHost(url)}
                  </span>
                </div>
                <SlotHealthBadge health={slotHealth[i]} />
              </div>
            ))}
          </div>
          <p className="font-mono text-[11px] text-[var(--fg-dim)]">
            Primary → public backups, in order. Health from the last boot probe.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
