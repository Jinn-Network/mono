'use client';

import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { daemonJson } from '@/lib/daemon';
import { classifySurface, SurfaceStatus, useDaemonJson } from '@/lib/use-daemon';

type RpcSlotHealth = { ok?: boolean; host?: string; latencyMs?: number };
type BootstrapPayload = {
  chain?: string;
  rpcUrls?: string[];
  publicDefaults?: string[];
  rpcSlotHealth?: RpcSlotHealth[];
};

type TaskPostCounts = {
  chain?: { h1: number; h6: number; h24: number };
};

function maskHost(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export default function NetworkPage() {
  const { data, loading, error, reload } = useDaemonJson<BootstrapPayload>(
    '/v1/bootstrap',
    1500,
  );
  const state = classifySurface({
    loading: loading && !data,
    error,
    empty: false,
  });

  if (state !== 'ready' && !data) {
    return (
      <div data-testid="network-tab">
        <SurfaceStatus name="network" state={state} />
      </div>
    );
  }

  const chain = data?.chain ?? 'base-sepolia';
  const publicDefaults = data?.publicDefaults ?? [];
  const rpcUrls = data?.rpcUrls ?? publicDefaults;
  const slotHealth = data?.rpcSlotHealth ?? [];

  return (
    <div data-testid="network-tab" className="flex flex-col gap-4">
      <NetworkEditor
        key={rpcUrls.join(',')}
        chain={chain}
        rpcUrls={rpcUrls}
        publicDefaults={publicDefaults}
        slotHealth={slotHealth}
        onSaved={() => {
          void reload();
        }}
      />
      <TaskPostsCard />
    </div>
  );
}

function NetworkEditor({
  chain,
  rpcUrls,
  publicDefaults,
  slotHealth,
  onSaved,
}: {
  chain: string;
  rpcUrls: string[];
  publicDefaults: string[];
  slotHealth: RpcSlotHealth[];
  onSaved: () => void;
}) {
  const primaryDefault = publicDefaults[0] ?? '';
  const initialPrimary = rpcUrls[0] && rpcUrls[0] !== primaryDefault ? rpcUrls[0] : '';
  const [primary, setPrimary] = useState(initialPrimary);
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await daemonJson('/v1/setup/network', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rpcUrl: primary.length > 0 ? primary : null }),
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Network</CardTitle>
        <CardDescription>{chain}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="primary-rpc">Primary RPC</Label>
          <Input
            id="primary-rpc"
            value={primary}
            onChange={(event) => setPrimary(event.target.value)}
          />
        </div>
        <Button type="button" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {rpcUrls.map((url, index) => (
            <li key={`${url}-${index}`} className="flex items-center gap-2 font-mono text-[12px]">
              <span>{maskHost(url)}</span>
              <Badge variant={slotHealth[index]?.ok ? 'outline' : 'warning'}>
                {slotHealth[index]?.ok ? 'ok' : 'unknown'}
              </Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function TaskPostsCard() {
  const { data, loading, error } = useDaemonJson<TaskPostCounts>(
    '/v1/discovery/task-post-counts',
    30_000,
  );
  const chain = data?.chain;
  const state = classifySurface({
    loading: loading && !data,
    error,
    empty: !chain || chain.h24 === 0,
  });

  let body;
  if (state !== 'ready') {
    body = <SurfaceStatus name="posting" state={state} />;
  } else if (chain) {
    body = (
      <div className="grid grid-cols-3 gap-4">
        {(
          [
            ['Last 1h', chain.h1],
            ['Last 6h', chain.h6],
            ['Last 24h', chain.h24],
          ] as const
        ).map(([label, count]) => (
          <div key={label} className="flex flex-col gap-1">
            <span className="font-mono text-[11px] tracking-[0.12em] text-dim uppercase">
              {label}
            </span>
            <span className="font-mono text-[20px]">{count}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <Card data-testid="network-task-posts">
      <CardHeader>
        <CardTitle>Task posts</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
