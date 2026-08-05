import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Onboarding, statusFor } from './Onboarding.js';
import type { BootstrapState } from '../../../../api/contract/index.js';

import type { JSX } from 'react';

// Mock the API client so we control what bootstrap + status data returns.
// `bootstrapOverride` lets individual tests tweak the returned bootstrap state
// without re-mocking the module.
let bootstrapOverride: Partial<BootstrapState> = {};
const SWE_CID = 'bafkreichswerebenchv2example';
const listRegistry = vi.fn();
const operatorJoin = vi.fn();
const completeOnboarding = vi.fn();
const harnessReadiness = vi.fn();

vi.mock('../api/client.js', () => ({
  api: {
    getBootstrap: async (): Promise<BootstrapState> => ({
      schemaVersion: 1,
      mode: 'setup',
      steps: ['wallet', 'safe_predicted', 'awaiting_funding'],
      currentStep: 'wallet',
      services: [],
      chain: 'base-sepolia',
      ...bootstrapOverride,
    }),
    // A hanging drip keeps AwaitingFundingCard in the `requesting` state so the
    // balance-vs-target readout (which only renders while requesting) is
    // assertable. Issue #979.
    triggerDrip: () => new Promise<never>(() => {}),
    solvernets: { listRegistry: () => listRegistry() },
    operator: {
      join: (...a: unknown[]) => operatorJoin(...a),
      completeOnboarding: () => completeOnboarding(),
    },
    harnessReadiness: (n: string) => harnessReadiness(n),
  },
}));

// The embedded agent panel mounts an xterm.js terminal; stub it so the
// onboarding tests stay free of the WebSocket / xterm setup.
vi.mock('./Agent.js', () => ({
  Agent: () => <div data-testid="agent-stub">agent</div>,
}));

afterEach(() => {
  cleanup();
  bootstrapOverride = {};
  delete (window as { __JINN_FEATURES__?: unknown }).__JINN_FEATURES__;
});

beforeEach(() => {
  listRegistry.mockReset();
  listRegistry.mockResolvedValue({
    summaries: [
      {
        manifestCid: SWE_CID,
        solverNetId: 'sn-swe-1',
        name: 'SWE-rebench v2',
        network: 'base-sepolia',
        launcherAgentId: '42',
        launcherSafeAddress: '0xabc0000000000000000000000000000000000001',
        status: 'launched',
        statusUpdatedAt: '2026-06-01T00:00:00.000Z',
        contractId: 'swe-rebench-v2',
        contractVersion: 'v1',
        solutionPriceWei: '0',
        verdictPriceWei: '0',
        openRoles: ['solver', 'evaluator'],
        anchorBlock: 1,
      },
    ],
    lastRefreshedAt: '2026-06-01T00:00:00.000Z',
    lastError: null,
  });
  operatorJoin.mockReset();
  operatorJoin.mockResolvedValue({
    ok: true,
    restartRequired: false,
    manifestCid: SWE_CID,
    config: { manifestCid: SWE_CID, roles: ['solver'], name: 'SWE-rebench v2' },
  });
  completeOnboarding.mockReset();
  completeOnboarding.mockResolvedValue({ ok: true, onboardingComplete: true });
  harnessReadiness.mockReset();
  harnessReadiness.mockResolvedValue({ harnessName: 'codex', manifestCids: [], ready: true });
});

function withQueryClient(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe('Onboarding (5-step rail)', () => {
  it('renders all five steps, with 4 & 5 queued during bootstrap', async () => {
    render(withQueryClient(<Onboarding />));

    // Wait for bootstrap data to load (queries are async)
    await screen.findByText(/Provisioning your wallet/i);

    expect(screen.getByText(/Provisioning your wallet/i)).toBeTruthy();
    expect(screen.getByText(/Fund your wallet/i)).toBeTruthy();
    expect(screen.getByText(/Joining Jinn/i)).toBeTruthy();
    expect(screen.getByText(/Pick your first SolverNet/i)).toBeTruthy();
    expect(screen.getByText(/Set up harness \+ model/i)).toBeTruthy();
    expect(screen.queryByText(/Sign in to Claude/i)).toBeNull();

    // Header reads "of 5".
    expect(screen.getByText(/Phase \d+ of 5/i)).toBeTruthy();

    // Steps 4 & 5 are queued: labels present but no live registry / readiness
    // fetch (their cards must NOT mount before the bootstrap flips terminal).
    expect(screen.getByTestId('onboarding-phase-4').getAttribute('data-status')).toBe('queued');
    expect(screen.getByTestId('onboarding-phase-5').getAttribute('data-status')).toBe('queued');
    expect(screen.queryByTestId('onboarding-solvernet-card')).toBeNull();
    expect(screen.queryByTestId('onboarding-solvernet-loading')).toBeNull();
    expect(screen.queryByTestId('onboarding-harness-card')).toBeNull();
    expect(listRegistry).not.toHaveBeenCalled();
    expect(harnessReadiness).not.toHaveBeenCalled();
  });

  it('does not render a Sign in to Claude phase', async () => {
    render(withQueryClient(<Onboarding />));
    await screen.findByText(/Provisioning your wallet/i);
    expect(screen.queryByText(/Sign in to Claude/i)).toBeNull();
  });

  // Issue #326 / #367: the embedded "Ask Claude" panel is hidden by default.
  // It renders only when the `embeddedAgent` feature flag is injected via
  // `window.__JINN_FEATURES__` (converged channel — see #367).
  it('hides the "Ask Claude" panel when no feature flags are injected', async () => {
    render(withQueryClient(<Onboarding />));
    await screen.findByText(/Provisioning your wallet/i);
    expect(screen.queryByText(/Ask Claude/i)).toBeNull();
    expect(screen.queryByTestId('agent-stub')).toBeNull();
  });

  it('hides the "Ask Claude" panel when embeddedAgent is false', async () => {
    window.__JINN_FEATURES__ = { embeddedAgent: false };
    render(withQueryClient(<Onboarding />));
    await screen.findByText(/Provisioning your wallet/i);
    expect(screen.queryByText(/Ask Claude/i)).toBeNull();
    expect(screen.queryByTestId('agent-stub')).toBeNull();
  });

  it('renders the "Ask Claude" panel when embeddedAgent is true', async () => {
    window.__JINN_FEATURES__ = { embeddedAgent: true };
    render(withQueryClient(<Onboarding />));
    await screen.findByText(/Provisioning your wallet/i);
    expect(screen.getByText(/Ask Claude/i)).toBeTruthy();
    expect(screen.getByTestId('agent-stub')).toBeTruthy();
  });
});

// Issue #110: Onboarding must gracefully render mode=uninitialized with
// empty services and a funding_required error envelope. The BootstrapErrorCard
// "Send ETH to" row must resolve details.address from the envelope.
describe('Onboarding with mode=uninitialized + funding_required error (issue #110)', () => {
  it('renders BootstrapErrorCard "Send ETH to" row with envelope details.address', async () => {
    bootstrapOverride = {
      mode: 'uninitialized',
      services: [],
      master_address: undefined,
      currentStep: 'wallet',
      error: {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        code: 'funding_required',
        exitCode: 10,
        message: 'EOA needs 0.01 ETH to continue; have 0',
        hint: 'Fund the address shown above, then re-run jinn run.',
        details: {
          category: 'insufficient_funds',
          address: '0xDeadBeefWalletAddress',
          requiredWei: '10000000000000000',
          haveWei: '0',
        },
      },
    };
    render(withQueryClient(<Onboarding />));
    // Wait for bootstrap data
    await screen.findByText(/Provisioning your wallet/i);
    // BootstrapErrorCard should render the funding address
    expect(screen.getByText('0xDeadBeefWalletAddress')).toBeTruthy();
  });

  it('does not crash when services is empty and master_address is undefined', async () => {
    bootstrapOverride = {
      mode: 'uninitialized',
      services: [],
      master_address: undefined,
      currentStep: 'wallet',
    };
    render(withQueryClient(<Onboarding />));
    // Should render the three phases without errors
    await screen.findByText(/Provisioning your wallet/i);
    expect(screen.getByText(/Fund your wallet/i)).toBeTruthy();
    expect(screen.getByText(/Joining Jinn/i)).toBeTruthy();
  });
});

// statusFor — determines whether a phase row is 'done', 'active', or
// 'queued'. The funding gate (jinn-mono-hjex.7): Phase 2 ("Fund your wallet")
// must stay 'active' until the funding gate explicitly clears, even when
// currentPhase has already advanced to 3. A single drip that briefly crossed
// the threshold must not flip phase 2 to DONE before the bootstrapper has
// actually advanced past awaiting_funding on-chain.
describe('statusFor phase machine', () => {
  it('marks earlier phases as done when currentPhase advances', () => {
    expect(statusFor(1, 3)).toBe('done');
    expect(statusFor(2, 3)).toBe('done');
    expect(statusFor(1, 2)).toBe('done');
  });

  it('marks the current phase as active', () => {
    expect(statusFor(1, 1)).toBe('active');
    expect(statusFor(2, 2)).toBe('active');
    expect(statusFor(3, 3)).toBe('active');
  });

  it('marks later phases as queued', () => {
    expect(statusFor(3, 2)).toBe('queued');
    expect(statusFor(3, 1)).toBe('queued');
    expect(statusFor(2, 1)).toBe('queued');
  });

  it('keeps Phase 2 active when funding.targetMet is false (hjex.7)', () => {
    // Explicit false: gate is still open even though step advanced to phase 3.
    expect(statusFor(2, 3, false)).toBe('active');
  });

  it('marks Phase 2 done when funding.targetMet is absent (gate cleared)', () => {
    expect(statusFor(2, 3, undefined)).toBe('done');
  });

  it('marks Phase 2 done when funding.targetMet is explicitly true', () => {
    expect(statusFor(2, 3, true)).toBe('done');
  });

  it('does not apply the funding gate hold to phases other than 2', () => {
    expect(statusFor(1, 3, false)).toBe('done');
  });

  it('Phase 2 stays active when it is the current phase, regardless of funding flag', () => {
    expect(statusFor(2, 2, false)).toBe('active');
    expect(statusFor(2, 2, undefined)).toBe('active');
    expect(statusFor(2, 2, true)).toBe('active');
  });
});

// Issue #979: the funding card must receive the live balance from the
// bootstrap poll so its progress bar reflects real funds climbing, not a
// fabricated time curve.
describe('Onboarding — funding card live balance (issue #979)', () => {
  it('passes funding.eth_balance into AwaitingFundingCard', async () => {
    bootstrapOverride = {
      mode: 'setup',
      currentStep: 'awaiting_funding',
      steps: ['wallet', 'safe_predicted', 'awaiting_funding'],
      master_address: '0x2222222222222222222222222222222222222222',
      funding: {
        eth_balance: '5000000000000000',
        eth_required: '5000000000000000',
        targetWei: '10000000000000000',
        targetMet: false,
      },
    };
    render(withQueryClient(<Onboarding />));
    await screen.findByText(/Fund your wallet/i);
    fireEvent.click(screen.getByRole('button', { name: /fund from faucet/i }));
    // Balance-vs-target readout proves the live balance reached the card.
    expect(await screen.findByText(/balance .* \/ target/i)).toBeTruthy();
  });
});

// ── #983: 5-step guided onboarding (SolverNet + harness + model) ──
// After the bootstrap state machine reaches terminal, Onboarding renders the
// two action steps. "Enter dashboard" stays disabled until ≥1 SolverNet is
// joined AND the chosen harness is ready AND a model is selected.
describe('Onboarding action steps (#983)', () => {
  const terminal: Partial<BootstrapState> = {
    mode: 'running',
    currentStep: 'complete',
    steps: ['complete'],
    joinedSolverNets: {},
  };

  it('renders the SolverNet step once bootstrap reaches terminal', async () => {
    bootstrapOverride = { ...terminal };
    render(withQueryClient(<Onboarding />));
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-solvernet-card')).toBeTruthy(),
    );
    // Step 4 becomes active (mounts SolverNetStep); step 5 stays queued until join.
    expect(screen.getByTestId('onboarding-phase-4').getAttribute('data-status')).toBe('active');
    expect(screen.getByTestId('onboarding-phase-5').getAttribute('data-status')).toBe('queued');
    expect(screen.queryByTestId('onboarding-harness-card')).toBeNull();
  });

  it('does not show Enter dashboard until a SolverNet is joined (step 5 queued)', async () => {
    bootstrapOverride = { ...terminal };
    render(withQueryClient(<Onboarding />));
    await waitFor(() => screen.getByTestId('onboarding-solvernet-join'));
    // Step 5 is queued (label-only) before any join — its content, including
    // the Enter-dashboard button, is not mounted yet.
    expect(screen.getByTestId('onboarding-phase-5').getAttribute('data-status')).toBe('queued');
    expect(screen.queryByTestId('onboarding-enter-dashboard')).toBeNull();
  });

  it('reveals the harness step after joining and shows Codex / gpt-5.4-mini default', async () => {
    // Already joined: the bootstrap view carries the membership so the harness
    // step renders without driving the join mutation through a re-poll.
    bootstrapOverride = {
      ...terminal,
      joinedSolverNets: {
        [SWE_CID]: { manifestCid: SWE_CID, roles: ['solver'] },
      },
    };
    render(withQueryClient(<Onboarding />));
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-harness-card')).toBeTruthy(),
    );
    // With a join present, step 5 is active and mounts the harness card.
    expect(screen.getByTestId('onboarding-phase-5').getAttribute('data-status')).toBe('active');
    const select = screen.getByTestId('onboarding-model-select') as HTMLSelectElement;
    expect(select.value).toBe('gpt-5.4-mini');
  });

  it('enables Enter dashboard once joined + harness ready + model selected', async () => {
    bootstrapOverride = {
      ...terminal,
      joinedSolverNets: {
        [SWE_CID]: { manifestCid: SWE_CID, roles: ['solver'] },
      },
    };
    render(withQueryClient(<Onboarding />));
    await waitFor(() => screen.getByTestId('onboarding-harness-card'));
    await waitFor(() => {
      const enter = screen.getByTestId('onboarding-enter-dashboard') as HTMLButtonElement;
      expect(enter.disabled).toBe(false);
    });
  });

  it('keeps Enter dashboard disabled while the harness is not ready', async () => {
    harnessReadiness.mockReset();
    harnessReadiness.mockResolvedValue({
      harnessName: 'codex',
      manifestCids: [],
      ready: false,
      reason: 'CLI not installed',
      nextStep: { description: 'Install codex', cli: 'brew install codex' },
    });
    bootstrapOverride = {
      ...terminal,
      joinedSolverNets: {
        [SWE_CID]: { manifestCid: SWE_CID, roles: ['solver'] },
      },
    };
    render(withQueryClient(<Onboarding />));
    await waitFor(() => screen.getByTestId('onboarding-harness-not-ready'));
    const enter = screen.getByTestId('onboarding-enter-dashboard') as HTMLButtonElement;
    expect(enter.disabled).toBe(true);
  });

  it('persists harness+model via a second join when entering the dashboard', async () => {
    bootstrapOverride = {
      ...terminal,
      joinedSolverNets: {
        [SWE_CID]: { manifestCid: SWE_CID, roles: ['solver'] },
      },
    };
    render(withQueryClient(<Onboarding />));
    await waitFor(() => {
      const enter = screen.getByTestId('onboarding-enter-dashboard') as HTMLButtonElement;
      expect(enter.disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('onboarding-enter-dashboard'));
    await waitFor(() => expect(operatorJoin).toHaveBeenCalled());
    const lastCall = operatorJoin.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe(SWE_CID); // upsert targets the real manifest cid
    expect(lastCall[1]).toMatchObject({ roles: ['solver'], harness: 'codex', model: 'gpt-5.4-mini' });
    // #983: clicking Enter dashboard writes the completion flag so App.tsx
    // drops the takeover.
    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledTimes(1));
  });

  it('persists the selected OpenRouter provider when entering the dashboard', async () => {
    bootstrapOverride = {
      ...terminal,
      joinedSolverNets: {
        [SWE_CID]: { manifestCid: SWE_CID, roles: ['solver'] },
      },
    };
    render(withQueryClient(<Onboarding />));
    await waitFor(() => screen.getByTestId('onboarding-harness-card'));

    fireEvent.click(screen.getByTestId('onboarding-harness-row-hermes-agent'));
    await waitFor(() =>
      expect((screen.getByTestId('onboarding-model-select') as HTMLSelectElement).value)
        .toBe('anthropic/claude-opus-4.7'),
    );
    await waitFor(() => {
      const enter = screen.getByTestId('onboarding-enter-dashboard') as HTMLButtonElement;
      expect(enter.disabled).toBe(false);
    });

    fireEvent.click(screen.getByTestId('onboarding-enter-dashboard'));
    await waitFor(() =>
      expect(operatorJoin).toHaveBeenCalledWith(SWE_CID, {
        roles: ['solver'],
        harness: 'hermes-agent',
        model: 'anthropic/claude-opus-4.7',
        provider: 'openrouter',
      }),
    );
  });

  it('surfaces an error when the Enter-dashboard mutation rejects', async () => {
    operatorJoin.mockReset();
    operatorJoin.mockRejectedValue(new Error('join_failed'));
    bootstrapOverride = {
      ...terminal,
      joinedSolverNets: {
        [SWE_CID]: { manifestCid: SWE_CID, roles: ['solver'] },
      },
    };
    render(withQueryClient(<Onboarding />));
    await waitFor(() => {
      const enter = screen.getByTestId('onboarding-enter-dashboard') as HTMLButtonElement;
      expect(enter.disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('onboarding-enter-dashboard'));
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-enter-error')).toBeTruthy(),
    );
  });
});
