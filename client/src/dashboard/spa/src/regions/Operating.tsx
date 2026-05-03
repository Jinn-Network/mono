/**
 * Operating — the running-state dashboard.
 *
 * Distinct from Onboarding (which dominates the screen until bootstrap
 * completes). Operating leads with the metrics a steady-state operator
 * actually checks (tasks delivered, earnings, gas runway), routes
 * recurring actions (claim, top-up, change password) into a single
 * actions column, and folds the long-tail (full event stream, fleet
 * detail) behind progressive-disclosure toggles. The agent panel takes
 * the right column at a width that lets claude's TUI render properly.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useEventStream } from '../api/events.js';
import { Agent } from './Agent.js';
import { SettingsCard } from './SettingsCard.js';

interface StatusV1 {
  daemon?: { version?: string; commit?: string; shutdownState?: string };
  rpc?: { ok?: boolean; chainId?: number; blockNumber?: number };
  fleet?: {
    loaded?: boolean;
    chain?: string;
    stakingMode?: string;
    masterAddress?: string | null;
    stakedLikeCount?: number;
    completeCount?: number;
    services?: Array<{
      index: number;
      step: string;
      serviceId?: number | null;
      safeAddress?: string | null;
      mechAddress?: string | null;
      stakingAddress?: string | null;
      agentId?: string | null;
      identityRegistryAddress?: string | null;
      safeBoundToAgent?: boolean;
      identityBindingStatus?: 'bound' | 'pending' | 'not_applicable';
    }>;
  };
  rewards?: {
    pendingStakingRewardsWei?: string;
    claimedStakingRewardsWei?: string;
    totalStakingRewardsWei?: string;
    lastClaimTickAt?: string | null;
    claimLoopIntervalMs?: number;
  };
  masterGas?: {
    address?: string | null;
    balanceWei?: string;
    runwayDaysExcess?: string;
    minEthWei?: string;
    error?: string;
  };
  portfolioV0?: {
    totals?: {
      delivered?: number;
      failed?: number;
      active?: number;
    };
    inFlight?: Array<{
      requestId: string;
      state: string;
      implName?: string;
    }>;
    recentVerdicts?: Array<{ state: 'COMPLETE' | 'FAILED'; deliveryTxHash?: string | null }>;
  };
  predictionV1?: {
    operator?: {
      ok: boolean;
      solverNet?: {
        name?: string;
        enabled?: boolean;
        solverType?: string;
        harness?: string;
        taskGeneratorEnabled?: boolean;
      };
      canonicalPlugin?: {
        name?: string;
        version?: string;
        source?: string | null;
      };
      harness?: {
        name: string;
        version: string;
        readiness?: {
          ready: boolean;
          reason?: string;
        };
      };
      diagnostics?: Array<{
        code: string;
        severity: 'error' | 'warning' | 'info';
        message: string;
        configField?: string;
      }>;
      nextAction?: {
        description: string;
        cli?: string;
      };
    } | null;
    operatorError?: string;
    totals?: {
      observedTasks?: number;
      activeTaskRuns?: number;
      solutions?: number;
      verdicts?: number;
      failed?: number;
    };
    latest?: {
      taskAt?: number | null;
      solutionAt?: number | null;
      verdictAt?: number | null;
    };
    recentTasks?: Array<{
      requestId: string;
      taskId?: string | null;
      state: string;
      taskRole?: 'restoration' | 'evaluation' | null;
      implName?: string | null;
      stateUpdatedAt: number;
      failureReason?: string | null;
    }>;
  };
}

const truncAddr = (s?: string): string =>
  !s ? '—' : s.length < 14 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;

const formatWei = (wei?: string): string => {
  if (!wei || wei === '0') return '0';
  try {
    const n = BigInt(wei);
    const eth = Number(n) / 1e18;
    if (eth < 0.0001) return eth.toExponential(2);
    return eth.toFixed(4);
  } catch {
    return wei;
  }
};

const explorerForChain = (chain?: string): string =>
  chain === 'base' ? 'https://basescan.org' : 'https://sepolia.basescan.org';

const formatStep = (step?: string): string => (step ?? 'unknown').replaceAll('_', ' ');

const formatOperatorStep = (step?: string): string => {
  switch (step) {
    case 'complete':
      return 'ready';
    case 'safe_binding_pending':
      return 'identity syncing';
    default:
      return formatStep(step);
  }
};

const formatTimestamp = (ts?: number | null): string => {
  if (ts === null || ts === undefined) return '—';
  const ms = Math.abs(ts) >= 10_000_000_000 ? ts : ts * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

const sumWei = (values: Array<string | undefined>): string => {
  try {
    return values.reduce<bigint>((acc, value) => acc + BigInt(value ?? '0'), 0n).toString();
  } catch {
    return values.find(Boolean) ?? '0';
  }
};

export function Operating(): JSX.Element {
  const { data: status, refetch } = useQuery<StatusV1>({
    queryKey: ['status'],
    queryFn: () => api.getStatus() as Promise<StatusV1>,
    refetchInterval: 5000,
  });

  const network = status?.fleet?.chain === 'base' ? 'mainnet' : 'testnet';
  const rpcOk = status?.rpc?.ok ?? false;
  const deliveredTasks =
    status?.portfolioV0?.totals?.delivered ??
    status?.portfolioV0?.recentVerdicts?.filter((v) => v.state === 'COMPLETE').length ??
    0;
  const pendingRewards = status?.rewards?.pendingStakingRewardsWei ?? '0';
  const totalRewards =
    status?.rewards?.totalStakingRewardsWei ??
    sumWei([status?.rewards?.claimedStakingRewardsWei, pendingRewards]);
  const runwayDays = status?.masterGas?.runwayDaysExcess ?? '—';
  const nodeStatus = rpcOk && (status?.fleet?.completeCount ?? 0) > 0 ? 'Running' : 'Needs attention';

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>
      <Header network={network} rpcOk={rpcOk} version={status?.daemon?.version} />

      <main className="max-w-[1440px] mx-auto px-10 py-8 grid grid-cols-12 gap-8">
        {/* Left column: metrics + actions + activity */}
        <section className="col-span-12 lg:col-span-7 flex flex-col gap-10">
          <Metrics
            deliveredTasks={deliveredTasks}
            totalRewardsWei={totalRewards}
            runwayDays={runwayDays}
            nodeStatus={nodeStatus}
            masterAddress={status?.masterGas?.address ?? undefined}
            chain={status?.fleet?.chain}
          />
          <PredictionPanel status={status} />
          <Actions status={status} onRefresh={() => { void refetch(); }} />
          <FleetWalletDetails status={status} />
          <Activity />
        </section>

        {/* Right column: agent — primary surface, given the room it needs */}
        <aside className="col-span-12 lg:col-span-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="j-label">Claude</span>
          </div>
          <div className="j-card overflow-hidden" style={{ minHeight: '720px', height: 'calc(100vh - 200px)' }}>
            <Agent />
          </div>
        </aside>
      </main>
    </div>
  );
}

function Header({
  network,
  rpcOk,
  version,
}: {
  network: string;
  rpcOk: boolean;
  version?: string;
}): JSX.Element {
  return (
    <header
      className="border-b"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--bg-sunken)',
      }}
    >
      <div className="max-w-[1440px] mx-auto px-10 py-5 flex items-baseline justify-between">
        <div className="flex items-baseline gap-6">
          <span
            className="j-display"
            style={{ fontSize: '32px', letterSpacing: '0.02em' }}
          >
            jinn operator
          </span>
          <div className="flex items-baseline gap-3">
            <span
              className="j-label"
              style={{
                color: 'var(--accent-sky)',
                padding: '4px 10px',
                border: '1px solid var(--accent-sky)',
                borderRadius: 'var(--radius-1)',
              }}
            >
              Testnet
            </span>
            <span
              className="j-label"
              style={{
                color: 'var(--fg-dim)',
                padding: '4px 10px',
                border: '1px dashed var(--border)',
                borderRadius: 'var(--radius-1)',
                opacity: 0.6,
              }}
              title="Mainnet support is coming. v1 supports testnet only."
            >
              Mainnet · soon
            </span>
          </div>
          <span
            className="j-label"
            style={{
              color: network === 'mainnet' ? 'var(--accent-gold)' : 'var(--fg-dim)',
              display: 'none',
            }}
          >
            {network}
          </span>
        </div>
        <div className="flex items-baseline gap-4">
          <span className="j-mono text-xs" style={{ color: rpcOk ? 'var(--vow-green)' : 'var(--break-red)' }}>
            ● {rpcOk ? 'rpc healthy' : 'rpc error'}
          </span>
          <span className="j-mono text-[10px]" style={{ color: 'var(--fg-dim)' }}>
            {version ?? 'unknown'}
          </span>
        </div>
      </div>
    </header>
  );
}

function PredictionPanel({ status }: { status?: StatusV1 }): JSX.Element {
  const prediction = status?.predictionV1;
  const operator = prediction?.operator;
  const diagnostics = operator?.diagnostics ?? [];
  const blockers = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
  const ready = operator?.ok === true && !prediction?.operatorError;
  const statusLabel = prediction
    ? ready
      ? 'Ready'
      : 'Needs attention'
    : 'Loading';
  const statusColor = ready
    ? 'var(--vow-green)'
    : prediction
      ? 'var(--wane)'
      : 'var(--fg-dim)';
  const pluginLabel = operator?.canonicalPlugin?.name
    ? `${operator.canonicalPlugin.name}@${operator.canonicalPlugin.version ?? 'unknown'}`
    : operator?.canonicalPlugin?.source ?? '—';
  const harnessLabel = operator?.harness
    ? `${operator.harness.name}@${operator.harness.version}`
    : operator?.solverNet?.harness ?? '—';
  const recentTasks = prediction?.recentTasks ?? [];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="j-label">Prediction SolverNet</span>
        <span className="j-mono text-[10px]" style={{ color: statusColor }}>
          {statusLabel}
        </span>
      </div>
      <div className="j-card-bare overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
        <div
          className="px-5 py-4 grid grid-cols-2 md:grid-cols-5 gap-4"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <PredictionStat label="tasks" value={prediction?.totals?.observedTasks ?? 0} />
          <PredictionStat label="active" value={prediction?.totals?.activeTaskRuns ?? 0} />
          <PredictionStat label="solutions" value={prediction?.totals?.solutions ?? 0} />
          <PredictionStat label="verdicts" value={prediction?.totals?.verdicts ?? 0} />
          <PredictionStat label="failed" value={prediction?.totals?.failed ?? 0} tone="warn" />
        </div>
        <div
          className="px-5 py-4 grid grid-cols-1 md:grid-cols-3 gap-4"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <PredictionDetail label="solver net" value={operator?.solverNet?.name ?? 'prediction'} />
          <PredictionDetail label="harness" value={harnessLabel} />
          <PredictionDetail label="plugin" value={pluginLabel} />
          <PredictionDetail label="task generator" value={operator?.solverNet?.taskGeneratorEnabled ? 'enabled' : 'disabled'} />
          <PredictionDetail label="latest solution" value={formatTimestamp(prediction?.latest?.solutionAt)} />
          <PredictionDetail label="latest verdict" value={formatTimestamp(prediction?.latest?.verdictAt)} />
        </div>
        <div className="px-5 py-4 flex flex-col gap-3">
          {prediction?.operatorError && (
            <span className="j-mono text-xs" style={{ color: 'var(--break-red)' }}>
              {prediction.operatorError}
            </span>
          )}
          {blockers.length > 0 || warnings.length > 0 ? (
            <div className="flex flex-col gap-2">
              {[...blockers, ...warnings].slice(0, 3).map((diagnostic) => (
                <div key={diagnostic.code} className="grid grid-cols-[88px_1fr] gap-3">
                  <span
                    className="j-label"
                    style={{ color: diagnostic.severity === 'error' ? 'var(--break-red)' : 'var(--wane)' }}
                  >
                    {diagnostic.severity}
                  </span>
                  <span className="j-mono text-xs" style={{ color: 'var(--fg-muted)' }}>
                    {diagnostic.message}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <span className="j-mono text-xs" style={{ color: 'var(--fg-muted)' }}>
              {operator?.nextAction?.description ?? 'No Prediction task runs recorded yet.'}
            </span>
          )}
          {operator?.nextAction?.cli && (
            <span className="j-mono text-[11px]" style={{ color: 'var(--accent-sky)' }}>
              {operator.nextAction.cli}
            </span>
          )}
          {recentTasks.length > 0 && (
            <div className="flex flex-col gap-2 pt-1">
              {recentTasks.slice(0, 3).map((task) => (
                <div
                  key={task.requestId}
                  className="grid grid-cols-[88px_1fr_auto] gap-3 items-baseline"
                  style={{ color: 'var(--fg-muted)' }}
                >
                  <span className="j-label">{task.taskRole === 'evaluation' ? 'verdict' : 'solution'}</span>
                  <span className="j-mono text-xs truncate">{task.taskId ?? task.requestId}</span>
                  <span className="j-mono text-[10px]">{task.state.toLowerCase()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function PredictionStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'default' | 'warn';
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="j-label">{label}</span>
      <span
        className="j-display tabular-nums"
        style={{
          fontSize: '28px',
          lineHeight: 1,
          color: tone === 'warn' && value > 0 ? 'var(--wane)' : 'var(--fg)',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function PredictionDetail({
  label,
  value,
}: {
  label: string;
  value: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="j-label">{label}</span>
      <span className="j-mono text-xs truncate" style={{ color: 'var(--fg)' }} title={value}>
        {value}
      </span>
    </div>
  );
}

function Metrics({
  deliveredTasks,
  totalRewardsWei,
  runwayDays,
  nodeStatus,
  masterAddress,
  chain,
}: {
  deliveredTasks: number;
  totalRewardsWei: string;
  runwayDays: string;
  nodeStatus: string;
  masterAddress?: string;
  chain?: string;
}): JSX.Element {
  const explorer = chain === 'base' ? 'https://basescan.org' : 'https://sepolia.basescan.org';
  return (
    <section>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-px" style={{ background: 'var(--border)' }}>
        <Metric
          label="tasks delivered"
          value={String(deliveredTasks)}
          tone="default"
        />
        <Metric
          label="total JINN earned"
          value={formatWei(totalRewardsWei)}
          unit="JINN"
          tone="gold"
        />
        <Metric
          label="gas runway"
          value={runwayDays}
          unit="days"
          tone="sky"
        />
        <Metric
          label="node status"
          value={nodeStatus}
          tone={nodeStatus === 'Running' ? 'green' : 'default'}
          compact
        />
      </div>
      {masterAddress && (
        <div className="mt-3 flex items-center gap-3 text-xs">
          <span className="j-label">gas wallet</span>
          <a
            href={`${explorer}/address/${masterAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="j-mono hover:underline"
            style={{ color: 'var(--accent-sky)' }}
          >
            {truncAddr(masterAddress)}
          </a>
        </div>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  unit,
  tone,
  compact,
}: {
  label: string;
  value: string;
  unit?: string;
  tone: 'default' | 'sky' | 'gold' | 'green';
  compact?: boolean;
}): JSX.Element {
  const valueColor =
    tone === 'gold'
      ? 'var(--accent-gold)'
      : tone === 'sky'
        ? 'var(--accent-sky)'
        : tone === 'green'
          ? 'var(--vow-green)'
          : 'var(--fg)';
  return (
    <div
      className="px-6 py-5 flex flex-col gap-3"
      style={{ background: 'var(--bg-elevated)' }}
    >
      <span className="j-label">{label}</span>
      <div className="flex items-baseline gap-2">
        <span
          className="j-display tabular-nums"
          style={{ fontSize: compact ? '30px' : '44px', color: valueColor, lineHeight: 1 }}
        >
          {value}
        </span>
        {unit && (
          <span className="j-mono text-xs" style={{ color: 'var(--fg-dim)' }}>
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

function Actions({
  status,
  onRefresh,
}: {
  status?: StatusV1;
  onRefresh: () => void;
}): JSX.Element {
  const [walletOpen, setWalletOpen] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [claimStatus, setClaimStatus] = useState<string | null>(null);
  const [topUpStatus, setTopUpStatus] = useState<string | null>(null);
  const [restartStatus, setRestartStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<'claim' | 'topup' | 'restart' | null>(null);
  const [topUpStartedAt, setTopUpStartedAt] = useState<number | null>(null);
  const [topUpElapsedSeconds, setTopUpElapsedSeconds] = useState(0);
  const masterAddress = status?.masterGas?.address ?? status?.fleet?.masterAddress ?? null;
  const chain = status?.fleet?.chain;
  const isTestnet = chain !== 'base';
  const claimableJinnWei = status?.rewards?.pendingStakingRewardsWei ?? '0';

  useEffect(() => {
    if (topUpStartedAt === null) return undefined;
    setTopUpElapsedSeconds(Math.max(0, Math.floor((Date.now() - topUpStartedAt) / 1000)));
    const id = window.setInterval(() => {
      setTopUpElapsedSeconds(Math.max(0, Math.floor((Date.now() - topUpStartedAt) / 1000)));
    }, 1_000);
    return () => window.clearInterval(id);
  }, [topUpStartedAt]);

  const topUpProgress = useMemo(() => {
    if (busy !== 'topup') return 0;
    return Math.min(92, Math.max(8, Math.round((topUpElapsedSeconds / 60) * 92)));
  }, [busy, topUpElapsedSeconds]);

  const claimRewards = async (): Promise<void> => {
    setBusy('claim');
    setClaimStatus(null);
    try {
      const res = await api.claimRewards();
      const result = res.result as
        | {
            submitted?: number;
            attempted?: number;
            skippedNoPending?: number;
            failedRecoverable?: number;
            failedPermanent?: number;
            claims?: Array<{ amountWei?: string; txHash?: string }>;
            message?: string;
          }
        | undefined;
      const submitted = result?.submitted ?? 0;
      const attempted = result?.attempted ?? 0;
      const failed = (result?.failedRecoverable ?? 0) + (result?.failedPermanent ?? 0);
      const claimedWei = result?.claims && result.claims.length > 0
        ? sumWei(result.claims.map((claim) => claim.amountWei))
        : claimableJinnWei;
      setClaimStatus(
        failed > 0
          ? `Claim finished with ${failed} failure${failed === 1 ? '' : 's'}.`
          : submitted > 0
            ? `Claimed ${formatWei(claimedWei)} JINN.`
            : `No JINN available to claim${attempted > 0 ? ` across ${attempted} service${attempted === 1 ? '' : 's'}` : ''}.`,
      );
      onRefresh();
    } catch (err) {
      setClaimStatus(err instanceof Error ? err.message : 'Claim failed');
    } finally {
      setBusy(null);
    }
  };

  const copyMasterAddress = async (): Promise<void> => {
    if (!masterAddress) return;
    await navigator.clipboard.writeText(masterAddress);
    setTopUpStatus('Master EOA copied.');
  };

  const fundFromFaucet = async (): Promise<void> => {
    setBusy('topup');
    setTopUpStatus(null);
    setTopUpStartedAt(Date.now());
    setTopUpElapsedSeconds(0);
    try {
      const res = await api.triggerDrip();
      if (res.ok) {
        const drips = res.txHashes?.length ?? res.attempts ?? (res.txHash ? 1 : 0);
        const balanceSummary =
          res.balanceWei && res.targetWei
            ? ` Balance ${formatWei(res.balanceWei)} / target ${formatWei(res.targetWei)} ETH.`
            : '';
        setTopUpStatus(
          `Faucet funding complete${drips > 0 ? ` (${drips} drip${drips === 1 ? '' : 's'})` : ''}.${balanceSummary}`,
        );
        onRefresh();
      } else {
        setTopUpStatus(res.reason ?? 'Faucet funding failed.');
      }
    } catch (err) {
      setTopUpStatus(err instanceof Error ? err.message : 'Faucet funding failed.');
    } finally {
      setTopUpStartedAt(null);
      setBusy(null);
    }
  };

  const restartDaemon = async (): Promise<void> => {
    setBusy('restart');
    setRestartStatus(null);
    try {
      await api.restartDaemon();
      setRestartStatus('Restart scheduled.');
    } catch (err) {
      setRestartStatus(err instanceof Error ? err.message : 'Restart failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <span className="j-label">Quick actions</span>
      <div className="grid grid-cols-2 gap-3">
        <ActionCard
          label="Claim JINN rewards"
          description={
            claimStatus ??
            `${formatWei(claimableJinnWei)} JINN claimable.`
          }
          onClick={claimRewards}
          disabled={busy !== null}
          rightHint={busy === 'claim' ? 'Running' : 'Claim'}
        />
        <ActionCard
          label="Top up gas"
          description={
            topUpStatus ??
            `${formatWei(status?.masterGas?.balanceWei)} ETH in gas wallet.`
          }
          onClick={() => setTopUpOpen((v) => !v)}
          disabled={busy !== null}
          rightHint={topUpOpen ? 'Close' : 'Open'}
        />
        <button
          type="button"
          onClick={() => setWalletOpen((v) => !v)}
          className="text-left px-5 py-4 flex flex-col gap-1 transition-colors"
          style={{
            background: walletOpen ? 'var(--bg-elevated)' : 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-2)',
            color: 'var(--fg)',
          }}
        >
          <span className="j-label" style={{ color: 'var(--accent-gold)' }}>
            Manage wallet {walletOpen ? '-' : '+'}
          </span>
          <span className="j-mono text-xs" style={{ color: 'var(--fg-muted)' }}>
            Change keystore password.
          </span>
        </button>
        <ActionCard
          label="Restart node"
          description={restartStatus ?? 'Gracefully stop this node so the launcher can restart it.'}
          onClick={restartDaemon}
          disabled={busy !== null}
          rightHint={busy === 'restart' ? 'Scheduling' : 'Restart'}
        />
      </div>
      {topUpOpen && (
        <div className="j-card-bare px-5 py-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="j-label">Gas wallet</span>
            <span className="j-mono text-xs break-all" style={{ color: 'var(--fg)' }}>
              {masterAddress ?? 'No master EOA in fleet state.'}
            </span>
            <span className="j-mono text-xs" style={{ color: 'var(--fg-muted)' }}>
              Balance {formatWei(status?.masterGas?.balanceWei)} ETH
              {status?.masterGas?.minEthWei ? ` / target ${formatWei(status.masterGas.minEthWei)} ETH` : ''}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={copyMasterAddress}
              disabled={!masterAddress}
              className="px-3 py-1.5 j-label disabled:opacity-50"
              style={{
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-1)',
                color: 'var(--fg)',
              }}
            >
              Copy address
            </button>
            {isTestnet && (
              <button
                type="button"
                onClick={fundFromFaucet}
                disabled={busy !== null || !masterAddress}
                className="px-3 py-1.5 j-label disabled:opacity-50"
                style={{
                  background: 'var(--accent-gold)',
                  borderRadius: 'var(--radius-1)',
                  color: 'var(--bg)',
                }}
              >
                {busy === 'topup' ? 'Funding...' : 'Fund from faucet'}
              </button>
            )}
            {masterAddress && (
              <a
                href={`${explorerForChain(chain)}/address/${masterAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 j-label"
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-1)',
                  color: 'var(--accent-sky)',
                }}
              >
                View on explorer
              </a>
            )}
          </div>
          {busy === 'topup' && (
            <div className="flex flex-col gap-2">
              <div
                className="h-1.5 overflow-hidden"
                style={{ background: 'var(--bg-sunken)', borderRadius: '999px' }}
              >
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${topUpProgress}%`,
                    background: 'var(--accent-gold)',
                    borderRadius: '999px',
                  }}
                />
              </div>
              <span className="j-mono text-[11px]" style={{ color: 'var(--fg-muted)' }}>
                Requesting faucet drips. Elapsed {topUpElapsedSeconds}s; this can take about a minute.
              </span>
            </div>
          )}
        </div>
      )}
      {walletOpen && (
        <div className="mt-2">
          <SettingsCard />
        </div>
      )}
    </section>
  );
}

function ActionCard({
  label,
  description,
  onClick,
  disabled,
  rightHint,
}: {
  label: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
  rightHint?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-left px-5 py-4 flex flex-col gap-1 transition-colors disabled:cursor-default"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-2)',
        color: 'var(--fg)',
        opacity: disabled ? 0.72 : 1,
      }}
    >
      <div className="flex items-baseline justify-between">
        <span className="j-label" style={{ color: 'var(--accent-sky)' }}>
          {label}
        </span>
        {rightHint && (
          <span className="j-mono text-[10px]" style={{ color: 'var(--fg-dim)' }}>
            {rightHint}
          </span>
        )}
      </div>
      <span className="j-mono text-xs" style={{ color: 'var(--fg-muted)' }}>
        {description}
      </span>
    </button>
  );
}

function FleetWalletDetails({ status }: { status?: StatusV1 }): JSX.Element {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const chain = status?.fleet?.chain;
  const explorer = explorerForChain(chain);
  const services = status?.fleet?.services ?? [];
  const masterAddress = status?.masterGas?.address ?? status?.fleet?.masterAddress ?? null;
  const primaryService = services[0];
  const identityStatus = primaryService?.identityBindingStatus ??
    (primaryService?.safeBoundToAgent ? 'bound' : primaryService?.agentId ? 'pending' : 'not_applicable');
  const identityLabel =
    identityStatus === 'bound'
      ? 'Active'
      : identityStatus === 'pending'
        ? 'Syncing'
        : 'Not set';
  const identityColor =
    identityStatus === 'bound'
      ? 'var(--vow-green)'
      : identityStatus === 'pending'
        ? 'var(--wane)'
        : 'var(--fg-dim)';

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="j-label">Operator</span>
        <span className="j-mono text-[10px]" style={{ color: 'var(--fg-dim)' }}>
          {chain === 'base' ? 'Base' : 'Base Sepolia'}
        </span>
      </div>
      <div className="j-card-bare overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
        <div
          className="px-5 py-4 grid grid-cols-1 md:grid-cols-[140px_1fr_auto] gap-3 md:gap-4 items-baseline"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <span className="j-label">Identity</span>
          <div className="flex flex-col gap-1">
            <span className="j-mono text-xs" style={{ color: identityColor }}>
              {identityLabel}
            </span>
            {primaryService?.agentId && primaryService.identityRegistryAddress && (
              <a
                href={`${explorer}/token/${primaryService.identityRegistryAddress}?a=${primaryService.agentId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="j-mono text-xs hover:underline"
                style={{ color: 'var(--accent-sky)' }}
              >
                Agent #{primaryService.agentId}
              </a>
            )}
          </div>
          <span className="j-mono text-[10px]" style={{ color: 'var(--fg-dim)' }}>
            {services.length > 0 ? 'Ready' : 'Setting up'}
          </span>
        </div>
        <div
          className="px-5 py-4 grid grid-cols-1 md:grid-cols-[140px_1fr_auto] gap-3 md:gap-4 items-baseline"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <span className="j-label">Gas wallet</span>
          <span className="j-mono text-xs break-all" style={{ color: 'var(--fg)' }}>
            {masterAddress ?? 'Not available'}
          </span>
          {masterAddress ? (
            <a
              href={`${explorer}/address/${masterAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="j-label hover:opacity-80"
              style={{ color: 'var(--accent-sky)' }}
            >
              Explorer
            </a>
          ) : (
            <span />
          )}
        </div>
        <div
          className="px-5 py-3 grid grid-cols-3 gap-4 j-mono text-xs"
          style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-muted)' }}
        >
          <span>network {chain === 'base' ? 'mainnet' : 'testnet'}</span>
          <span>node {status?.fleet?.completeCount ? 'ready' : 'setting up'}</span>
          <span>tasks {status?.portfolioV0?.totals?.active ?? status?.portfolioV0?.inFlight?.length ?? 0} active</span>
        </div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="w-full px-5 py-3 flex items-center justify-between text-left"
          style={{ color: 'var(--fg-muted)' }}
        >
          <span className="j-label">Advanced details</span>
          <span className="j-mono text-[10px]">{advancedOpen ? 'Hide' : 'Show'}</span>
        </button>
        {advancedOpen && services.length === 0 && (
          <div className="px-5 py-5 j-mono text-xs" style={{ color: 'var(--fg-dim)' }}>
            No local service rows yet.
          </div>
        )}
        {advancedOpen && services.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left j-mono text-xs">
              <thead>
                <tr style={{ color: 'var(--fg-dim)' }}>
                  <th className="px-5 py-3 font-normal">local</th>
                  <th className="px-5 py-3 font-normal">network id</th>
                  <th className="px-5 py-3 font-normal">state</th>
                  <th className="px-5 py-3 font-normal">safe</th>
                  <th className="px-5 py-3 font-normal">mech</th>
                  <th className="px-5 py-3 font-normal">staking</th>
                </tr>
              </thead>
              <tbody>
                {services.map((svc) => (
                  <tr key={svc.index} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="px-5 py-3" style={{ color: 'var(--fg)' }}>
                      #{svc.index}
                    </td>
                    <td className="px-5 py-3" style={{ color: 'var(--fg)' }}>
                      {svc.serviceId ?? '-'}
                    </td>
                    <td className="px-5 py-3" style={{ color: 'var(--accent-gold)' }}>
                      {formatOperatorStep(svc.step)}
                    </td>
                    <AddressCell address={svc.safeAddress} explorer={explorer} />
                    <AddressCell address={svc.mechAddress} explorer={explorer} />
                    <AddressCell address={svc.stakingAddress} explorer={explorer} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function AddressCell({
  address,
  explorer,
}: {
  address?: string | null;
  explorer: string;
}): JSX.Element {
  return (
    <td className="px-5 py-3">
      {address ? (
        <a
          href={`${explorer}/address/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
          style={{ color: 'var(--accent-sky)' }}
        >
          {truncAddr(address)}
        </a>
      ) : (
        <span style={{ color: 'var(--fg-dim)' }}>-</span>
      )}
    </td>
  );
}

function Activity(): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  // Default filter: only meaningful kinds. logs are noisy and collapsed-by-default.
  const kinds = showLogs
    ? ['intent', 'reward', 'fleet', 'system', 'error', 'log']
    : ['intent', 'reward', 'fleet', 'error'];
  const { events, connected } = useEventStream(kinds);
  const visible = expanded ? events.slice(-200) : events.slice(-5);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="j-label">Recent activity</span>
        <div className="flex items-center gap-3">
          <span
            className="j-mono text-[10px]"
            style={{ color: connected ? 'var(--vow-green)' : 'var(--wane)' }}
          >
            {connected ? '● live' : '○ reconnecting'}
          </span>
          <button
            type="button"
            onClick={() => setShowLogs((v) => !v)}
            className="j-label hover:opacity-80"
            style={{ color: 'var(--fg-dim)', fontSize: '10px' }}
          >
            {showLogs ? 'hide logs' : 'show logs'}
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="j-label hover:opacity-80"
            style={{ color: 'var(--accent-sky)', fontSize: '10px' }}
          >
            {expanded ? 'collapse' : 'view all'}
          </button>
        </div>
      </div>
      <div
        className="j-card-bare overflow-hidden"
        style={{ background: 'var(--bg-elevated)' }}
      >
        {visible.length === 0 ? (
          <div
            className="j-mono text-xs px-5 py-6"
            style={{ color: 'var(--fg-dim)' }}
          >
            Quiet. The daemon is running; nothing has happened recently.
          </div>
        ) : (
          <ul>
            {visible
              .slice()
              .reverse()
              .map((e, i) => (
                <li
                  key={e.id}
                  className="px-5 py-3 grid grid-cols-[68px_84px_1fr_auto] gap-4 items-baseline j-mono text-xs"
                  style={{
                    borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                    color: 'var(--fg-muted)',
                  }}
                >
                  <span style={{ color: 'var(--fg-dim)' }}>{e.ts.slice(11, 19)}</span>
                  <span
                    style={{
                      color:
                        e.kind === 'error'
                          ? 'var(--break-red)'
                          : e.kind === 'reward'
                            ? 'var(--accent-gold)'
                            : e.kind === 'intent'
                              ? 'var(--accent-sky)'
                              : 'var(--fg-dim)',
                    }}
                  >
                    {e.kind}
                  </span>
                  <span style={{ color: 'var(--fg)' }}>{e.message}</span>
                  {e.txHash && (
                    <a
                      href={`https://basescan.org/tx/${e.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                      style={{ color: 'var(--accent-sky)' }}
                    >
                      tx ↗
                    </a>
                  )}
                </li>
              ))}
          </ul>
        )}
      </div>
    </section>
  );
}
