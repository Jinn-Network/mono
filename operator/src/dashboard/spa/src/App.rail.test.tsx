import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Issue #326 / #367 — the operating-shell embedded agent rail renders only
 * when the `embeddedAgent` feature flag is injected via
 * `window.__JINN_FEATURES__`. The Onboarding "Ask Claude" panel path is
 * covered in `regions/Onboarding.test.tsx`; these tests cover the running-mode
 * rail, which `App.tsx` gates on the same converged flag channel.
 */

vi.mock('./api/connection-state.js', () => ({
  useConnectionState: () => ({ status: 'connected', lastConnectedAt: 0 }),
}));

// Drive App into the running branch so the operating shell (and its rail)
// mounts. #983: the running-mode → <Operating> gate requires onboarding to be
// complete, so set the flag here (else App holds the onboarding takeover).
vi.mock('./api/client.js', () => ({
  api: {
    getBootstrap: async () => ({
      mode: 'running',
      chain: 'base-sepolia',
      executionWiring: [{
        workKind: 'prediction.v1',
        harness: 'claude-code',
        model: 'claude-haiku-4-5-20251001',
        plugins: [],
        credentialRef: 'claude-code-default',
        isolationPolicy: 'process',
      }],
      onboardingComplete: true,
    }),
  },
}));

// The pre-running `LoadingScreen` branch opens a `/v1/events` EventSource,
// which jsdom does not provide. Stub it to a marker — this test only cares
// about the running-mode operating shell.
vi.mock('./regions/LoadingScreen.js', () => ({
  LoadingScreen: () => <div data-testid="loading-screen" />,
}));

// Stub AppShell down to a marker that just renders whatever `rail` it was
// handed — App.tsx passes `<AgentRail />` or `undefined` depending on the
// flag, so this is the precise gating behaviour under test. Stubbing here
// also avoids pulling in the heavy page subtrees the real shell mounts.
vi.mock('./shell/AppShell.js', () => ({
  AppShell: ({ rail }: { rail?: ReactNode }) => (
    <div data-testid="app-shell">{rail ?? null}</div>
  ),
}));

vi.mock('./shell/AgentRail.js', () => ({
  AgentRail: () => <div data-testid="agent-rail" />,
}));

async function renderApp(): Promise<void> {
  const { default: App } = await import('./App.js');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.resetModules();
  delete (window as { __JINN_FEATURES__?: unknown }).__JINN_FEATURES__;
});

describe('App operating-shell agent rail (issue #367 converged flag)', () => {
  it('hides the agent rail when no feature flags are injected', async () => {
    await renderApp();
    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeTruthy());
    expect(screen.queryByTestId('agent-rail')).toBeNull();
  });

  it('hides the agent rail when embeddedAgent is false', async () => {
    window.__JINN_FEATURES__ = { embeddedAgent: false };
    await renderApp();
    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeTruthy());
    expect(screen.queryByTestId('agent-rail')).toBeNull();
  });

  it('renders the agent rail when embeddedAgent is true', async () => {
    window.__JINN_FEATURES__ = { embeddedAgent: true };
    await renderApp();
    await waitFor(() => expect(screen.getByTestId('agent-rail')).toBeTruthy());
  });
});
