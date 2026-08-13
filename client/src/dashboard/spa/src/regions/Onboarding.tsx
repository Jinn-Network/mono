/**
 * Onboarding — full-screen takeover while the fleet bootstraps.
 *
 * Four operator-meaningful steps displayed as a single always-visible list:
 *
 *   01 · Provisioning your wallet      (wallet, safe_predicted)
 *   02 · Fund your wallet              (awaiting_funding)
 *   03 · Joining Jinn                  (everything else through mech_deployed)
 *   04 · Set up harness + model        (post-terminal; HarnessSelectStep)
 *
 * Each row shows status (done · active · queued). The active row expands
 * inline with whatever the operator needs at that moment — the funding
 * address card in step 2, a current sub-state line in step 3, the harness
 * picker in step 4. Done rows collapse to a thin checkmark line. Queued rows
 * are dim.
 *
 * Step 4 stays `queued` (label-only) while the bootstrap state machine is
 * still running. It must NOT mount HarnessSelectStep before
 * `bootstrapIsTerminal()` — that step fetches live harness readiness, which
 * 503s before the running flip.
 *
 * Wave-4 D1 (DR-2026-08-05) removed the former step 4 ("Pick your first
 * SolverNet"): the `joinedSolverNets` claim gate and its join lifecycle
 * retired with the legacy TaskEngine, so there is no join to make here.
 * SolverNet membership is operator config plus the `jinn solver-nets` CLI.
 *
 * Once bootstrap reaches 'complete' the daemon flips mode to 'running'; the
 * App-level overlay keeps the takeover mounted until onboarding is marked
 * complete, then routes to <Operating>.
 *
 * Per-harness auth (formerly Phase 1 "Sign in to Claude") moved to the
 * /operator join flow in Stage B (vh74.2). Onboarding now covers only the
 * phases that genuinely require pre-running-mode completion.
 *
 * Per-step sub-components live under `./onboarding/` — PhaseRow,
 * PhaseStatusTag, NetworkBadge, SubStateLine, BootstrapErrorCard — to
 * keep this file a thin composition (shadcn C.7).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { BootstrapState } from '../../../../api/contract/index.js';
import { AwaitingFundingCard } from './AwaitingFundingCard.js';
import { Agent } from './Agent.js';
import { getFeatures } from '../lib/features.js';
import { Progress } from '../components/ui/progress.js';
import { Card } from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.js';
import { cn } from '../lib/utils.js';
import { BootstrapErrorCard } from './onboarding/BootstrapErrorCard.js';
import { NetworkBadge } from './onboarding/NetworkBadge.js';
import { PhaseRow, type Phase } from './onboarding/PhaseRow.js';
import { type PhaseStatus } from './onboarding/PhaseStatusTag.js';
import { SubStateLine } from './onboarding/SubStateLine.js';
import { HarnessSelectStep, type HarnessSelection } from './onboarding/HarnessSelectStep.js';

import { useCallback, useState, type JSX } from 'react';

/** Bootstrap steps that mean the earning state machine has reached terminal. */
const TERMINAL_STEPS = new Set(['complete', 'safe_binding_pending']);

/**
 * The action step (harness/model) mounts its live card once the bootstrap
 * state machine reaches terminal OR the daemon has already flipped to
 * running. Until then that row renders label-only (queued).
 */
function bootstrapIsTerminal(bootstrap: BootstrapState): boolean {
  return bootstrap.mode === 'running' || TERMINAL_STEPS.has(bootstrap.currentStep);
}

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
  // #2407: the daemon's fleet-phase list now reports `awaiting_stake`
  // (previously mis-reported as `wallet` by the endpoint's own sync bug —
  // see client/src/earning/fleet-bootstrap-phase.ts). It's the first
  // per-service step in both progressions, same phase/subState as its
  // siblings below.
  awaiting_stake: { phase: 3, subState: 'Deploying' },
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
  const queryClient = useQueryClient();
  const { data: bootstrap, isLoading } = useQuery<BootstrapState>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
    refetchInterval: 2000,
  });

  // #983 action-step selection state. `harnessSel` is captured from
  // HarnessSelectStep; the completion gate reads it alongside the joined set.
  const [harnessSel, setHarnessSel] = useState<HarnessSelection | null>(null);
  const onSelectionChange = useCallback((sel: HarnessSelection) => setHarnessSel(sel), []);

  // Mark onboarding complete so App.tsx drops the takeover for <Operating>.
  // The App-level overlay closes the takeover once mode===running AND
  // onboardingComplete — set by completeOnboarding() below. Wave-4 D1 dropped
  // the harness/model upsert that used to ride this mutation: it wrote into
  // `joinedSolverNets`, whose write path retired with the claim gate.
  const enterMutation = useMutation({
    mutationFn: async () => {
      await api.operator.completeOnboarding();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
    },
  });

  const completionReady = harnessSel?.ready === true && Boolean(harnessSel?.model);

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
  const isTerminal = bootstrapIsTerminal(bootstrap);
  // Current step across the full 4-step rail. Steps 1-3 follow the bootstrap
  // phase; step 4 is active once the bootstrap is terminal.
  const currentStep: Phase = isTerminal ? 4 : currentPhase;
  const bootstrapError = bootstrap.error;
  // #983: the App-level completion overlay keeps Onboarding mounted in running
  // mode until the operator enters the dashboard. A running-mode bootstrap
  // response may omit `services`, so default to an empty array rather than
  // crashing on `.find`.
  const services = bootstrap.services ?? [];
  const activeService =
    services.find((svc) => svc.step === bootstrap.currentStep) ?? services[0];
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
              five steps. The PhaseRow list below is the source of truth
              for state; this bar is a glance-level cue so the operator
              knows roughly how far they are. */}
          <div
            className="flex flex-col gap-1.5"
            data-testid="onboarding-progress"
            aria-label="Onboarding progress"
          >
            <Progress value={Math.min(100, ((currentStep - 1) / 3) * 100)} />
            <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]">
              Phase {currentStep} of 4
            </span>
          </div>

          <ol className="flex flex-col">
            {([1, 2, 3, 4] as Phase[]).map((p) => {
              const status = statusFor(p, currentStep, fundingTargetMet);
              const showError = bootstrapError && p === currentStep && p <= 3;
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
                      currentBalanceWei={bootstrap.funding?.eth_balance}
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
                  {/* Step 4 — harness + model. Mounts the live readiness card
                      only once the bootstrap is terminal (queued rows are
                      label-only; the readiness endpoint 503s before the running
                      flip). Hosts the completion gate (Enter dashboard). */}
                  {p === 4 && status === 'active' && (
                    <div className="flex flex-col gap-6">
                      <HarnessSelectStep onSelectionChange={onSelectionChange} />
                      {enterMutation.isError && (
                        <Alert variant="blocking" data-testid="onboarding-enter-error">
                          <AlertTitle>Could not enter the dashboard.</AlertTitle>
                          <AlertDescription>
                            Completing onboarding failed. Try again; check daemon
                            logs if it keeps failing.
                          </AlertDescription>
                        </Alert>
                      )}
                      <Button
                        data-testid="onboarding-enter-dashboard"
                        disabled={!completionReady || enterMutation.isPending}
                        onClick={() => enterMutation.mutate()}
                        className="self-start"
                      >
                        {enterMutation.isPending ? 'Starting…' : 'Enter dashboard'}
                      </Button>
                    </div>
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
