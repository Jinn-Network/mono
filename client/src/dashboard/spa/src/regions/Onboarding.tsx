/**
 * Onboarding — full-screen takeover while the fleet bootstraps.
 *
 * Three operator-meaningful phases displayed as an always-visible list:
 *
 *   01 · Provisioning your wallet      (wallet, safe_predicted)
 *   02 · Fund your wallet              (awaiting_funding)
 *   03 · Joining Jinn                  (everything else through mech_deployed)
 *
 * Each row shows status (done · active · queued). The active row expands
 * inline with whatever the operator needs at that moment — the funding
 * address card in phase 2, a current sub-state line in phase 3. Done rows
 * collapse to a thin checkmark line. Queued rows are dim.
 *
 * Once bootstrap reaches 'complete' the daemon flips mode to 'running' and
 * App.tsx routes to <Operating>. Silent transition, no Phase 4.
 *
 * Per-harness auth (formerly Phase 1 "Sign in to Claude") moved to the
 * /operator join flow in Stage B (vh74.2). Onboarding now covers only the
 * phases that genuinely require pre-running-mode completion.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../api/client.js';
import type {
  BootstrapErrorEnvelope,
  BootstrapState,
} from '../api/types.js';
import { AwaitingFundingCard } from './AwaitingFundingCard.js';
import { Agent } from './Agent.js';

type Phase = 1 | 2 | 3;
type PhaseStatus = 'done' | 'active' | 'queued' | 'error';

interface BootstrapPhaseDescriptor {
  /** The bootstrap-specific phase (1, 2, or 3). */
  phase: Phase;
  /** Sub-state hint shown in the active row in Phase 3. Null otherwise. */
  subState: string | null;
}

const PHASE_FOR_STEP: Record<string, BootstrapPhaseDescriptor> = {
  wallet: { phase: 1, subState: null },
  safe_predicted: { phase: 1, subState: null },
  awaiting_funding: { phase: 2, subState: null },
  safe_deployed: { phase: 3, subState: 'Deploying' },
  service_created: { phase: 3, subState: 'Deploying' },
  service_activated: { phase: 3, subState: 'Deploying' },
  agents_registered: { phase: 3, subState: 'Deploying' },
  service_deployed: { phase: 3, subState: 'Deploying' },
  service_staked: { phase: 3, subState: 'Deploying' },
  staked: { phase: 3, subState: 'Deploying' },
  mech_deployed: { phase: 3, subState: 'Joining the network' },
  agent_registered: { phase: 3, subState: 'Joining the network' },
  safe_binding_pending: { phase: 3, subState: 'Binding identity' },
};

const PHASE_TITLES: Record<Phase, string> = {
  1: 'Provisioning your wallet',
  2: 'Fund your wallet',
  3: 'Joining Jinn',
};

function bootstrapPhaseFor(step: string): BootstrapPhaseDescriptor {
  return PHASE_FOR_STEP[step] ?? { phase: 1, subState: null };
}

function statusFor(rowPhase: Phase, currentPhase: Phase): PhaseStatus {
  if (rowPhase < currentPhase) return 'done';
  if (rowPhase === currentPhase) return 'active';
  return 'queued';
}

export function Onboarding(): JSX.Element {
  const { data: bootstrap, isLoading } = useQuery<BootstrapState>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
    refetchInterval: 2000,
  });

  if (isLoading || !bootstrap) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: 'var(--bg)' }}
      >
        <span className="j-label">Connecting…</span>
      </div>
    );
  }

  const explorer =
    bootstrap.chain === 'base' ? 'https://basescan.org' : 'https://sepolia.basescan.org';
  const masterAddress = bootstrap.master_address ?? '';
  const { phase: currentPhase, subState } = bootstrapPhaseFor(bootstrap.currentStep);
  const bootstrapError = bootstrap.error;
  const activeService = bootstrap.services.find((svc) => svc.step === bootstrap.currentStep)
    ?? bootstrap.services[0];

  return (
    <div
      className="min-h-screen w-full"
      style={{ background: 'var(--bg)', color: 'var(--fg)' }}
    >
      <style>{ANIMATIONS}</style>

      <div className="max-w-[1280px] mx-auto px-10 py-10 grid grid-cols-12 gap-10">
        <section className="col-span-12 lg:col-span-7 flex flex-col gap-8">
          <header className="flex items-baseline justify-between">
            <span className="j-label" style={{ color: 'var(--accent-gold)' }}>
              Jinn · Onboarding
            </span>
            <NetworkBadge chain={bootstrap.chain} />
          </header>

          <h1
            className="j-display"
            style={{ fontSize: '76px', color: 'var(--fg)', lineHeight: 1.05 }}
          >
            Welcome to Jinn.
          </h1>

          <ol className="flex flex-col">
            {([1, 2, 3] as Phase[]).map((p) => {
              const status = statusFor(p, currentPhase);
              const showError = bootstrapError && p === currentPhase;
              return (
                <PhaseRow key={p} phase={p} status={showError ? 'error' : status}>
                  {showError && <BootstrapErrorCard envelope={bootstrapError} />}
                  {!showError && p === 2 && status === 'active' && masterAddress && (
                    <AwaitingFundingCard
                      address={masterAddress}
                      minimumWei={bootstrap.funding?.targetWei ?? '10000000000000000'}
                      chainExplorerBase={explorer}
                    />
                  )}
                  {!showError && p === 3 && status === 'active' && (
                    <SubStateLine
                      label={subState ?? 'Working'}
                      step={bootstrap.currentStep}
                      serviceIndex={activeService?.index}
                      serviceId={activeService?.service_id}
                      safeAddress={activeService?.safe_address}
                      explorer={explorer}
                    />
                  )}
                </PhaseRow>
              );
            })}
          </ol>
        </section>

        <aside className="col-span-12 lg:col-span-5 flex flex-col gap-3">
          <span className="j-label">Ask Claude</span>
          <div
            className="j-card overflow-hidden"
            style={{ height: 'calc(100vh - 220px)', minHeight: '520px' }}
          >
            <Agent agentGated={false} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function NetworkBadge({ chain }: { chain?: string }): JSX.Element {
  const isMainnet = chain === 'base';
  return (
    <div className="flex items-center gap-3">
      <span
        className="j-label"
        style={{
          color: !isMainnet ? 'var(--accent-sky)' : 'var(--fg-dim)',
          padding: '4px 10px',
          border: !isMainnet ? '1px solid var(--accent-sky)' : '1px solid var(--border)',
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
  );
}

function PhaseRow({
  phase,
  status,
  children,
}: {
  phase: Phase;
  status: PhaseStatus;
  children: ReactNode;
}): JSX.Element {
  const isActive = status === 'active';
  const isError = status === 'error';
  const isDone = status === 'done';
  const expanded = isActive || isError;

  const indexColor = isError
    ? 'var(--break-red)'
    : isActive
      ? 'var(--accent-gold)'
      : isDone
        ? 'var(--accent-sky)'
        : 'var(--fg-dim)';
  const titleColor = isError
    ? 'var(--fg)'
    : isActive
      ? 'var(--fg)'
      : isDone
        ? 'var(--fg-muted)'
        : 'var(--fg-dim)';

  return (
    <li
      className="phase-row"
      data-status={status}
      style={{
        borderTop: '1px solid var(--border)',
      }}
    >
      <div className="grid grid-cols-[3rem_1fr_auto] items-baseline gap-4 py-4">
        <span
          className="j-mono text-xs tabular-nums"
          style={{
            color: indexColor,
            letterSpacing: '0.05em',
            transition: 'color 240ms ease',
          }}
        >
          {String(phase).padStart(2, '0')}
        </span>
        <span
          className={expanded ? 'j-display' : 'j-mono'}
          style={{
            fontSize: expanded ? '28px' : '14px',
            color: titleColor,
            lineHeight: 1.2,
            transition: 'color 240ms ease',
          }}
        >
          {PHASE_TITLES[phase]}
        </span>
        <PhaseStatusTag status={status} />
      </div>
      {expanded && children && (
        <div
          className="ml-12 pb-5 pr-2"
          style={{ animation: 'jinnFadeSlide 320ms ease-out both' }}
        >
          {children}
        </div>
      )}
    </li>
  );
}

function PhaseStatusTag({ status }: { status: PhaseStatus }): JSX.Element {
  if (status === 'done') {
    return (
      <span
        className="j-label"
        style={{ color: 'var(--vow-green)', fontSize: '10px' }}
      >
        ✓ Done
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span
        className="j-label"
        style={{ color: 'var(--break-red)', fontSize: '10px' }}
      >
        ! Failed
      </span>
    );
  }
  if (status === 'active') {
    return (
      <span
        className="j-label flex items-center gap-2"
        style={{ color: 'var(--accent-gold)', fontSize: '10px' }}
      >
        <ActivePulse />
        Active
      </span>
    );
  }
  return (
    <span
      className="j-label"
      style={{ color: 'var(--fg-dim)', fontSize: '10px' }}
    >
      Queued
    </span>
  );
}

function ActivePulse(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: 'var(--accent-gold)',
        boxShadow: '0 0 0 0 rgba(220, 184, 102, 0.6)',
        animation: 'jinnPulse 1.6s ease-out infinite',
      }}
    />
  );
}

function BootstrapErrorCard({ envelope }: { envelope: BootstrapErrorEnvelope }): JSX.Element {
  const txHash = extractTxHash(envelope);
  const generatedAt = formatRelativeTime(envelope.generatedAt);
  return (
    <div
      className="px-5 py-4 flex flex-col gap-3"
      style={{
        border: '1px solid var(--break-red)',
        background: 'rgba(168, 90, 90, 0.06)',
        borderRadius: 'var(--radius-2)',
      }}
    >
      <div className="flex items-baseline justify-between">
        <span className="j-label" style={{ color: 'var(--break-red)' }}>
          Bootstrap halted · {envelope.code}
        </span>
        {generatedAt && (
          <span className="j-mono text-[10px]" style={{ color: 'var(--fg-dim)' }}>
            {generatedAt}
          </span>
        )}
      </div>
      <p className="j-mono text-xs break-words" style={{ color: 'var(--fg)' }}>
        {envelope.message}
      </p>
      {envelope.hint && (
        <p className="j-mono text-xs" style={{ color: 'var(--fg-muted)' }}>
          <span style={{ color: 'var(--fg-dim)' }}>Fix · </span>
          {envelope.hint}
        </p>
      )}
      {txHash && (
        <a
          href={`https://sepolia.basescan.org/tx/${txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="j-mono text-[11px] hover:underline self-start"
          style={{ color: 'var(--accent-sky)' }}
        >
          view failed tx ↗
        </a>
      )}
      <p className="j-mono text-[11px]" style={{ color: 'var(--fg-dim)' }}>
        Setup is paused at this step. Once you've addressed the cause, run{' '}
        <code style={{ color: 'var(--fg-muted)' }}>jinn run</code> again to retry from
        the persisted state.
      </p>
    </div>
  );
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

function SubStateLine({
  label,
  step,
  serviceIndex,
  serviceId,
  safeAddress,
  explorer,
}: {
  label: string;
  step: string;
  serviceIndex?: number;
  serviceId?: number;
  safeAddress?: string;
  explorer: string;
}): JSX.Element {
  return (
    <div
      className="px-4 py-3 flex flex-col gap-3"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-2)',
        background: 'var(--bg-elevated)',
      }}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: 'var(--accent-sky)',
            boxShadow: '0 0 0 0 rgba(122, 167, 220, 0.6)',
            animation: 'jinnPulse 1.6s ease-out infinite',
          }}
        />
        <span className="j-mono text-sm" style={{ color: 'var(--fg)' }}>
          {label}
        </span>
        <span
          className="j-mono text-[10px] ml-auto"
          style={{ color: 'var(--fg-dim)' }}
        >
          running · no action needed
        </span>
      </div>
      <div
        className="grid grid-cols-1 md:grid-cols-[120px_1fr] gap-x-4 gap-y-1 j-mono text-[11px]"
        style={{ color: 'var(--fg-muted)' }}
      >
        <span style={{ color: 'var(--fg-dim)' }}>Current step</span>
        <span>{formatOperatorStep(step)}</span>
        {serviceIndex !== undefined && (
          <>
            <span style={{ color: 'var(--fg-dim)' }}>Service</span>
            <span>
              #{serviceIndex}{serviceId !== undefined ? ` · id ${serviceId}` : ''}
            </span>
          </>
        )}
        {safeAddress && (
          <>
            <span style={{ color: 'var(--fg-dim)' }}>Safe</span>
            <a
              href={`${explorer}/address/${safeAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline break-all"
              style={{ color: 'var(--accent-sky)' }}
            >
              {safeAddress}
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function formatOperatorStep(step: string): string {
  return step
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const ANIMATIONS = `
  @keyframes jinnPulse {
    0%   { box-shadow: 0 0 0 0 rgba(220, 184, 102, 0.55); }
    70%  { box-shadow: 0 0 0 10px rgba(220, 184, 102, 0); }
    100% { box-shadow: 0 0 0 0 rgba(220, 184, 102, 0); }
  }
  @keyframes jinnFadeSlide {
    0%   { opacity: 0; transform: translateY(-4px); }
    100% { opacity: 1; transform: translateY(0); }
  }
  /* Smooth title scaling when a row activates */
  .phase-row[data-status="active"] {
    background:
      linear-gradient(90deg, rgba(220, 184, 102, 0.04) 0%, transparent 60%);
    transition: background 320ms ease;
  }
`;
