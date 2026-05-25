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
 *
 * Per-step sub-components live under `./onboarding/` — PhaseRow,
 * PhaseStatusTag, NetworkBadge, SubStateLine, BootstrapErrorCard — to
 * keep this file a thin composition (shadcn C.7).
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { BootstrapState } from '../api/types.js';
import { AwaitingFundingCard } from './AwaitingFundingCard.js';
import { Agent } from './Agent.js';
import { getFeatures } from '../lib/features.js';
import { Progress } from '../components/ui/progress.js';
import { Card } from '../components/ui/card.js';
import { cn } from '../lib/utils.js';
import { BootstrapErrorCard } from './onboarding/BootstrapErrorCard.js';
import { NetworkBadge } from './onboarding/NetworkBadge.js';
import { PhaseRow, type Phase } from './onboarding/PhaseRow.js';
import { type PhaseStatus } from './onboarding/PhaseStatusTag.js';
import { SubStateLine } from './onboarding/SubStateLine.js';

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

function bootstrapPhaseFor(step: string): BootstrapPhaseDescriptor {
  return PHASE_FOR_STEP[step] ?? { phase: 1, subState: null };
}

/** @internal exported for unit tests */
export function statusFor(
  rowPhase: Phase,
  currentPhase: Phase,
  fundingTargetMet?: boolean,
): PhaseStatus {
  if (rowPhase < currentPhase) {
    // Phase 2 (Fund your wallet) stays 'active' until the endpoint explicitly
    // signals that the balance target is met. This prevents a momentary drip
    // that briefly crossed the threshold from flipping phase 2 to DONE before
    // the bootstrapper has actually advanced past awaiting_funding on-chain.
    //
    // `fundingTargetMet === false` (explicit false from the funding gate) means
    // the gate is still open; absent funding block means the gate has cleared.
    // (Numbering note: hjex.7 was authored against the 4-phase shape where
    // Fund was Phase 3; after vh74.2 collapsed Onboarding to 3 phases, Fund
    // is now Phase 2.)
    if (rowPhase === 2 && fundingTargetMet === false) return 'active';
    return 'done';
  }
  if (rowPhase === currentPhase) return 'active';
  return 'queued';
}

const eyebrow =
  'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--accent-gold)]';

export function Onboarding(): JSX.Element {
  const { data: bootstrap, isLoading } = useQuery<BootstrapState>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
    refetchInterval: 2000,
  });

  if (isLoading || !bootstrap) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]">
          Connecting…
        </span>
      </div>
    );
  }

  const explorer =
    bootstrap.chain === 'base' ? 'https://basescan.org' : 'https://sepolia.basescan.org';
  const masterAddress = bootstrap.master_address ?? '';
  const { phase: currentPhase, subState } = bootstrapPhaseFor(bootstrap.currentStep);
  const bootstrapError = bootstrap.error;
  const activeService =
    bootstrap.services.find((svc) => svc.step === bootstrap.currentStep) ?? bootstrap.services[0];
  // hjex.7: explicit `false` means the funding gate is still open; absent
  // (undefined) means the bootstrapper has cleared funding. The statusFor()
  // helper keeps Phase 3 (Fund your wallet) 'active' until this clears, so a
  // momentary drip that briefly crossed the threshold doesn't flip the row
  // to DONE before the bootstrapper advances past awaiting_funding on-chain.
  const fundingTargetMet = bootstrap.funding?.targetMet;
  // Issue #326 / #367: the embedded "Ask Claude" panel renders only when the
  // daemon reports the surface is enabled (JINN_ENABLE_EMBEDDED_AGENT=1). When
  // off, the bootstrap-progress column spans the full width. Read via the
  // `window.__JINN_FEATURES__` channel like every other operator-app flag.
  const embeddedAgentEnabled = getFeatures().embeddedAgent;

  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      <div className="mx-auto grid max-w-[1280px] grid-cols-12 gap-10 px-10 py-10">
        <section
          className={cn(
            'col-span-12 flex flex-col gap-8',
            embeddedAgentEnabled && 'lg:col-span-7',
          )}
        >
          <header className="flex items-baseline justify-between">
            <span className={eyebrow}>Jinn · Onboarding</span>
            <NetworkBadge chain={bootstrap.chain} />
          </header>

          <h1 className="font-serif text-[76px] leading-[1.05] text-foreground">
            Welcome to Jinn.
          </h1>

          {/* Bootstrap progress — visualises overall completion across the
              three phases. The PhaseRow list below is the source of truth
              for state; this bar is a glance-level cue so the operator
              knows roughly how far they are. */}
          <div
            className="flex flex-col gap-1.5"
            data-testid="onboarding-progress"
            aria-label="Onboarding progress"
          >
            <Progress
              value={Math.min(
                100,
                ((currentPhase - 1) / 2) * 100 + (currentPhase === 3 ? 33 : 0),
              )}
            />
            <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]">
              Phase {currentPhase} of 3
            </span>
          </div>

          <ol className="flex flex-col">
            {([1, 2, 3] as Phase[]).map((p) => {
              const status = statusFor(p, currentPhase, fundingTargetMet);
              const showError = bootstrapError && p === currentPhase;
              return (
                <PhaseRow key={p} phase={p} status={showError ? 'error' : status}>
                  {showError && (
                    <BootstrapErrorCard
                      envelope={bootstrapError}
                      chainExplorerBase={explorer}
                    />
                  )}
                  {!showError && p === 2 && status === 'active' && masterAddress && (
                    <AwaitingFundingCard
                      address={masterAddress}
                      minimumWei={bootstrap.funding?.targetWei ?? '10000000000000000'}
                      chainExplorerBase={explorer}
                      chain={bootstrap.chain}
                      onSharedDefaultRpc={bootstrap.rpcUrl === bootstrap.defaultRpcUrl}
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
                      contractRevertReason={activeService?.error_revert_reason ?? null}
                    />
                  )}
                </PhaseRow>
              );
            })}
          </ol>
        </section>

        {embeddedAgentEnabled && (
          <aside className="col-span-12 flex flex-col gap-3 lg:col-span-5">
            <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]">
              Ask Claude
            </span>
            <Card className="h-[calc(100vh-220px)] min-h-[520px] overflow-hidden p-0">
              <Agent agentGated={false} />
            </Card>
          </aside>
        )}
      </div>
    </div>
  );
}
