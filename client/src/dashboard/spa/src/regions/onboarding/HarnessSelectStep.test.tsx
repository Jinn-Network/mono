import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { HarnessSelectStep } from './HarnessSelectStep.js';

const harnessReadiness = vi.fn();
vi.mock('../../api/client.js', () => ({
  api: { harnessReadiness: (n: string) => harnessReadiness(n) },
}));

function wrap(node: ReactNode) {
  // gcTime: 0 so a query is dropped the moment its observer unmounts — keeps a
  // prior test's readiness probe (and its refetchInterval) from outliving the
  // test and racing the next mock.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe('HarnessSelectStep', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    harnessReadiness.mockReset();
    // Benign default: a leaked refetch from a prior test (its observer may
    // outlive cleanup by a tick) resolves cleanly instead of hitting the
    // next test's not-yet-installed / rejecting mock and surfacing an
    // unhandled rejection. Each test overrides this as needed.
    harnessReadiness.mockResolvedValue({ harnessName: 'codex', manifestCids: [], ready: true });
  });

  it('defaults to Codex / gpt-5.4-mini', async () => {
    harnessReadiness.mockResolvedValue({ harnessName: 'codex', manifestCids: [], ready: true });
    const onChange = vi.fn();
    render(wrap(<HarnessSelectStep onSelectionChange={onChange} />));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.harness).toBe('codex');
    expect(last.model).toBe('gpt-5.4-mini');
  });

  it('reports not-ready (gate stays closed) and shows a setup block', async () => {
    harnessReadiness.mockResolvedValue({
      harnessName: 'codex',
      manifestCids: [],
      ready: false,
      reason: 'CLI not installed',
      nextStep: { description: 'Install codex', cli: 'brew install codex' },
    });
    const onChange = vi.fn();
    render(wrap(<HarnessSelectStep onSelectionChange={onChange} />));
    await waitFor(() => expect(screen.getByTestId('onboarding-harness-not-ready')).toBeTruthy());
    await waitFor(() => expect(onChange.mock.calls.at(-1)![0].ready).toBe(false));
  });

  it('re-enables when a recheck reports ready', async () => {
    harnessReadiness
      .mockResolvedValueOnce({ harnessName: 'codex', manifestCids: [], ready: false, reason: 'x' })
      .mockResolvedValue({ harnessName: 'codex', manifestCids: [], ready: true });
    const onChange = vi.fn();
    render(wrap(<HarnessSelectStep onSelectionChange={onChange} />));
    await waitFor(() => screen.getByTestId('onboarding-harness-recheck'));
    fireEvent.click(screen.getByTestId('onboarding-harness-recheck'));
    await waitFor(() => expect(onChange.mock.calls.at(-1)![0].ready).toBe(true));
  });

  it('treats a 503 / unknown probe as checking, not not-ready', async () => {
    // Throw inside an async impl rather than `mockRejectedValue` — the latter
    // eagerly builds a rejected promise vitest tracks as unhandled even though
    // the component's queryFn catches it. An async throw is created lazily per
    // call and consumed by the queryFn's try/catch.
    harnessReadiness.mockImplementation(async () => {
      throw Object.assign(new Error('503'), { code: 'subsystem_not_ready' });
    });
    const onChange = vi.fn();
    render(wrap(<HarnessSelectStep onSelectionChange={onChange} />));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // The probe is swallowed to "checking", so the not-ready setup block must
    // NOT appear and the gate stays reported-closed (ready: false).
    await waitFor(() =>
      expect(screen.queryByTestId('onboarding-harness-not-ready')).toBeNull(),
    );
    expect(onChange.mock.calls.at(-1)![0].ready).toBe(false);
  });
});
