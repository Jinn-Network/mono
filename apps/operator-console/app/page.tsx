'use client';

import { useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { daemonJson } from '@/lib/daemon';
import {
  formatWeiAsEth,
  fundingMinimumWei,
  isAwaitingFunding,
  type FundingSnapshot,
} from '@/lib/funding';
import { classifySurface, SurfaceStatus } from '@/lib/use-daemon';

type StatusPayload = {
  contractVersion?: { major: number; minor: number };
  fleet?: {
    masterAddress?: string | null;
    services?: Array<{
      serviceId?: number | null;
      safeAddress?: string | null;
      agentId?: string | null;
    }>;
  };
  balances?: { eth?: { agent?: { address?: string | null } } };
  postingEntries?: number;
};

type RewardsPayload = {
  totalPending?: string;
  totalClaimed?: string;
  readState?: 'ready' | 'error';
};

type BootstrapPayload = FundingSnapshot & {
  onboardingComplete?: boolean;
  master_address?: string;
};

function primaryService(status: StatusPayload | null):
  | NonNullable<NonNullable<StatusPayload['fleet']>['services']>[number]
  | undefined {
  return status?.fleet?.services?.[0];
}

export default function OverviewPage() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [rewards, setRewards] = useState<RewardsPayload | null>(null);
  const [rewardsUnavailable, setRewardsUnavailable] = useState(false);
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dripping, setDripping] = useState(false);
  const optedIn = useRef(false);
  const lastMinimum = useRef<string | undefined>(undefined);
  const postedOnboarding = useRef(false);

  async function load(): Promise<void> {
    try {
      const [nextStatus, rewardsResult, nextBootstrap] = await Promise.all([
        daemonJson<StatusPayload>('/v1/status'),
        daemonJson<RewardsPayload>('/v1/rewards').then(
          (payload) => ({ ok: true as const, payload }),
          (err: unknown) => ({
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
        daemonJson<BootstrapPayload>('/v1/bootstrap'),
      ]);
      setStatus(nextStatus);
      setBootstrap(nextBootstrap);
      if (rewardsResult.ok) {
        setRewards(rewardsResult.payload);
        setRewardsUnavailable(rewardsResult.payload.readState === 'error');
      } else {
        setRewardsUnavailable(true);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      void load();
    }, 1500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (postedOnboarding.current) return;
    if (bootstrap?.mode !== 'running') return;
    if (bootstrap.onboardingComplete === true) return;
    postedOnboarding.current = true;
    void daemonJson('/v1/operator/onboarding-complete', { method: 'POST' }).catch(() => {
      postedOnboarding.current = false;
    });
  }, [bootstrap]);

  async function requestDrip(): Promise<void> {
    setDripping(true);
    try {
      await daemonJson('/v1/setup/drip', { method: 'POST' });
      await load();
    } finally {
      setDripping(false);
    }
  }

  const minimumWei = fundingMinimumWei(bootstrap);
  useEffect(() => {
    if (minimumWei !== lastMinimum.current) {
      lastMinimum.current = minimumWei;
      if (optedIn.current && isAwaitingFunding(bootstrap)) {
        void requestDrip();
      }
    }
  }, [minimumWei, bootstrap]);

  const awaiting = isAwaitingFunding(bootstrap);
  const running = bootstrap?.mode === 'running' || bootstrap?.onboardingComplete === true;
  const state = classifySurface({
    loading,
    error,
    empty: !status && !bootstrap,
  });

  if (state !== 'ready') {
    return <SurfaceStatus name="overview" state={state} />;
  }

  if (awaiting) {
    const required = formatWeiAsEth(minimumWei) ?? 'ETH';
    return (
      <Card data-testid="funding-card">
        <CardHeader>
          <CardTitle>Fund the master EOA</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="m-0 font-mono text-[13px]">{required}</p>
          <Button
            type="button"
            disabled={dripping}
            onClick={() => {
              optedIn.current = true;
              void requestDrip();
            }}
          >
            {dripping ? 'Funding…' : 'Fund from faucet'}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const service = primaryService(status);
  const master =
    status?.fleet?.masterAddress ?? bootstrap?.master_address ?? '—';
  const agent = status?.balances?.eth?.agent?.address ?? '—';
  const safe = service?.safeAddress ?? '—';
  const serviceId = service?.serviceId ?? '—';
  const agentId = service?.agentId ?? '—';
  const pending = rewards?.totalPending;

  return (
    <div data-testid="overview-page-grid" className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-2 sm:col-span-3">
            <p className="m-0 font-mono text-[11px] tracking-[0.14em] text-dim uppercase">
              Identity
            </p>
            <p className="m-0 font-mono text-[13px]" data-testid="identity-master">
              Master {master}
            </p>
            <p className="m-0 font-mono text-[13px]" data-testid="identity-agent">
              Agent {agent}
            </p>
            <p className="m-0 font-mono text-[13px]" data-testid="identity-safe">
              Safe {safe}
            </p>
            <p className="m-0 font-mono text-[13px]" data-testid="identity-service-id">
              Service {serviceId}
            </p>
            <p className="m-0 font-mono text-[13px]" data-testid="identity-agent-id">
              Agent ID {agentId}
            </p>
          </div>
          <div>
            <p className="m-0 font-mono text-[11px] tracking-[0.14em] text-dim uppercase">
              Rewards
            </p>
            {pending !== undefined ? (
              <p className="m-0 font-mono text-[13px]" data-testid="rewards-value">
                {pending}
              </p>
            ) : null}
            {rewardsUnavailable ? (
              <p
                className="m-0 font-mono text-[13px] text-dim"
                data-testid="rewards-unavailable"
              >
                unavailable
              </p>
            ) : pending === undefined ? (
              <p className="m-0 font-mono text-[13px]" data-testid="rewards-value">
                —
              </p>
            ) : null}
          </div>
          <div>
            <p className="m-0 font-mono text-[11px] tracking-[0.14em] text-dim uppercase">
              Posting
            </p>
            <p className="m-0 font-mono text-[13px]">{status?.postingEntries ?? 0}</p>
          </div>
        </CardContent>
      </Card>
      {running ? (
        <Card data-testid="activity-card">
          <CardHeader>
            <CardTitle>Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="outline">{bootstrap?.currentStep ?? 'running'}</Badge>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
