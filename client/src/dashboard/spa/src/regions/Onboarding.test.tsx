import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Onboarding, statusFor } from './Onboarding.js';
import type { BootstrapState } from '../api/types.js';

import type { JSX } from 'react';

// Mock the API client so we control what bootstrap + status data returns.
// `bootstrapOverride` lets individual tests tweak the returned bootstrap state
// without re-mocking the module.
let bootstrapOverride: Partial<BootstrapState> = {};

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
  },
}));

// The embedded agent panel mounts an xterm.js terminal; stub it so the
// onboarding tests stay free of the WebSocket / xterm setup.
vi.mock('./Agent.js', () => ({
  Agent: () => <div data-testid="agent-stub">agent</div>,
}));

afterEach(() => {
  bootstrapOverride = {};
  delete (window as { __JINN_FEATURES__?: unknown }).__JINN_FEATURES__;
});

function withQueryClient(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe('Onboarding (3-phase post-vh74.2)', () => {
  it('renders exactly three phases', async () => {
    render(withQueryClient(<Onboarding />));

    // Wait for bootstrap data to load (queries are async)
    await screen.findByText(/Provisioning your wallet/i);

    expect(screen.getByText(/Provisioning your wallet/i)).toBeTruthy();
    expect(screen.getByText(/Fund your wallet/i)).toBeTruthy();
    expect(screen.getByText(/Joining Jinn/i)).toBeTruthy();
    expect(screen.queryByText(/Sign in to Claude/i)).toBeNull();
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
