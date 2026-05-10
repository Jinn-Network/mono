import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { deriveLiveNow, LiveNowBand, type LiveNowStatusInput } from './LiveNowBand.js';
import { api } from '../../api/client.js';

vi.mock('../../api/client.js', () => ({
  api: {
    getStatus: vi.fn(),
  },
}));

function wrap(ui: JSX.Element): void {
  const nav = memoryLocation({ path: '/overview', record: true });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={nav.hook}>{ui}</Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('deriveLiveNow', () => {
  it('returns idle when no in-flight tasks, no diagnostics, services complete', () => {
    const result = deriveLiveNow({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      activity: { recent: [{ ts: '2026-05-07T13:46:45.710Z', kind: 'startup' }] },
      predictionV1: { totals: { activeTaskRuns: 0 }, recentTasks: [] },
    });
    expect(result.state).toBe('idle');
    expect(result.line).toBe('waiting for next task');
    expect(result.meta).toContain('idle since');
    expect(result.cta.href).toBe('/overview/activity');
  });

  it('returns working when activeTaskRuns > 0, with restoration verb summary', () => {
    const now = Date.now();
    const result = deriveLiveNow({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      predictionV1: {
        totals: { activeTaskRuns: 2 },
        recentTasks: [
          { state: 'RUNNING', taskRole: 'restoration', stateUpdatedAt: now - 100_000 },
          { state: 'CLAIMED', taskRole: 'restoration', stateUpdatedAt: now - 30_000 },
        ],
      },
    });
    expect(result.state).toBe('working');
    expect(result.line).toBe('2 tasks restoring');
    expect(result.meta).toMatch(/longest in flight/);
  });

  it('returns working from generic taskRuns even when prediction status is idle', () => {
    const now = Date.now();
    const result = deriveLiveNow({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      taskRuns: {
        totals: { activeTaskRuns: 1 },
        inFlight: [
          { state: 'RUNNING', taskRole: 'restoration', stateUpdatedAt: now - 45_000 },
        ],
      },
      predictionV1: { totals: { activeTaskRuns: 0 }, recentTasks: [] },
    });
    expect(result.state).toBe('working');
    expect(result.line).toBe('1 task restoring');
  });

  it('returns working with mixed verb when both restoration and evaluation in flight', () => {
    const result = deriveLiveNow({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      predictionV1: {
        totals: { activeTaskRuns: 3 },
        recentTasks: [
          { state: 'RUNNING', taskRole: 'restoration', stateUpdatedAt: Date.now() - 60_000 },
          { state: 'RUNNING', taskRole: 'restoration', stateUpdatedAt: Date.now() - 40_000 },
          { state: 'PACKAGING', taskRole: 'evaluation', stateUpdatedAt: Date.now() - 10_000 },
        ],
      },
    });
    expect(result.state).toBe('working');
    expect(result.line).toBe('2 restoring · 1 evaluating');
  });

  it('returns attention on first error-severity diagnostic, mirrors AlertBand trigger', () => {
    const result = deriveLiveNow({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      predictionV1: {
        totals: { activeTaskRuns: 0 },
        operator: {
          diagnostics: [
            {
              code: 'harness_mismatch',
              severity: 'error',
              message: 'Selected Harness does not support prediction.v1 restoration Tasks.',
            },
          ],
        },
      },
    });
    expect(result.state).toBe('attention');
    expect(result.line).toContain('does not support prediction.v1');
    expect(result.cta.label).toBe('Configure SolverNet');
    // Harness diagnostics route to the SolverNets section so the operator
    // can pick the matching joined-net card and edit its harness inline.
    expect(result.cta.href).toBe('/operator#solvernets');
  });

  it('excludes prediction_solvernet_disabled from attention triggers', () => {
    const result = deriveLiveNow({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      predictionV1: {
        totals: { activeTaskRuns: 0 },
        operator: {
          diagnostics: [
            {
              code: 'prediction_solvernet_disabled',
              severity: 'error',
              message: 'No SolverNet selected.',
            },
          ],
        },
      },
    });
    // Falls through to idle since the only diagnostic is excluded.
    expect(result.state).toBe('idle');
  });

  it('surfaces attentionMore when multiple diagnostics exist', () => {
    const result = deriveLiveNow({
      fleet: { services: [{ index: 0, step: 'complete' }] },
      predictionV1: {
        totals: { activeTaskRuns: 0 },
        operator: {
          diagnostics: [
            { code: 'harness_mismatch', severity: 'error', message: 'msg one' },
            { code: 'other_error', severity: 'error', message: 'msg two' },
            { code: 'third_error', severity: 'error', message: 'msg three' },
          ],
        },
      },
    });
    expect(result.state).toBe('attention');
    expect(result.line).toBe('msg one');
    expect(result.attentionMore).toBe(2);
  });

  it('returns bootstrapping when any service step is incomplete', () => {
    const result = deriveLiveNow({
      fleet: {
        services: [
          { index: 0, step: 'complete' },
          { index: 1, step: 'service_deployed' },
        ],
      },
      predictionV1: { totals: { activeTaskRuns: 0 } },
    });
    expect(result.state).toBe('bootstrapping');
    expect(result.line).toBe('1/2 services complete');
    expect(result.meta).toContain('next:');
  });

  it('treats safe_binding_pending as a complete-equivalent step', () => {
    const result = deriveLiveNow({
      fleet: {
        services: [
          { index: 0, step: 'complete' },
          { index: 1, step: 'safe_binding_pending' },
        ],
      },
      predictionV1: { totals: { activeTaskRuns: 0 } },
    });
    expect(result.state).toBe('idle');
  });

  it('priorities: bootstrapping > attention > working > idle', () => {
    // Bootstrapping wins over attention.
    const result = deriveLiveNow({
      fleet: { services: [{ index: 0, step: 'wallet' }] },
      predictionV1: {
        totals: { activeTaskRuns: 5 },
        operator: {
          diagnostics: [{ code: 'x', severity: 'error', message: 'oops' }],
        },
      },
    });
    expect(result.state).toBe('bootstrapping');
  });

  it('handles undefined input safely (returns idle defaults)', () => {
    const result = deriveLiveNow(undefined);
    expect(result.state).toBe('idle');
    expect(result.line).toBe('waiting for next task');
  });
});

describe('<LiveNowBand />', () => {
  it('renders the working state with verb summary', async () => {
    const status: LiveNowStatusInput = {
      fleet: { services: [{ index: 0, step: 'complete' }] },
      predictionV1: {
        totals: { activeTaskRuns: 1 },
        recentTasks: [
          {
            state: 'RUNNING',
            taskRole: 'restoration',
            stateUpdatedAt: Date.now() - 30_000,
          },
        ],
      },
    };
    vi.mocked(api.getStatus).mockResolvedValue(status);

    wrap(<LiveNowBand />);

    await waitFor(() => {
      const band = screen.getByTestId('live-now-band');
      expect(band.getAttribute('data-state')).toBe('working');
    });
    expect(screen.getByTestId('live-now-line').textContent).toContain('1 task restoring');
    expect(screen.getByTestId('live-now-cta').textContent).toMatch(/View activity/);
  });

  it('renders the attention state with diagnostic message and CTA', async () => {
    const status: LiveNowStatusInput = {
      fleet: { services: [{ index: 0, step: 'complete' }] },
      predictionV1: {
        totals: { activeTaskRuns: 0 },
        operator: {
          diagnostics: [
            {
              code: 'harness_mismatch',
              severity: 'error',
              message: 'Selected Harness does not support prediction.v1 restoration Tasks.',
            },
          ],
        },
      },
    };
    vi.mocked(api.getStatus).mockResolvedValue(status);

    wrap(<LiveNowBand />);

    await waitFor(() => {
      const band = screen.getByTestId('live-now-band');
      expect(band.getAttribute('data-state')).toBe('attention');
    });
    expect(screen.getByTestId('live-now-line').textContent).toContain('does not support');
    // In attention state the right-side CTA IS the fix-it action; the
    // operator goes to /operator#solvernets where the per-net harness
    // editor lives.
    expect(screen.getByTestId('live-now-cta').textContent).toMatch(/Configure SolverNet/);
  });

  it('renders the "N more" pill when multiple attention diagnostics exist', async () => {
    const status: LiveNowStatusInput = {
      fleet: { services: [{ index: 0, step: 'complete' }] },
      predictionV1: {
        totals: { activeTaskRuns: 0 },
        operator: {
          diagnostics: [
            { code: 'a', severity: 'error', message: 'one' },
            { code: 'b', severity: 'error', message: 'two' },
            { code: 'c', severity: 'error', message: 'three' },
          ],
        },
      },
    };
    vi.mocked(api.getStatus).mockResolvedValue(status);

    wrap(<LiveNowBand />);

    await waitFor(() => {
      expect(screen.getByTestId('live-now-attention-more').textContent).toContain('2 more');
    });
  });
});
