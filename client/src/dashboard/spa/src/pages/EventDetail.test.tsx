import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { EventDetailPage } from './EventDetail.js';
import { api } from '../api/client.js';
import { EVENT_KIND_META, LIFECYCLE_KINDS } from '../lib/event-kinds.js';
import type { ActivityEventRow } from '../../../../api/contract/index.js';

vi.mock('../api/client.js', () => ({
  api: {
    getActivityEvent: vi.fn(),
    getBootstrap: vi.fn(),
  },
}));

function event(extra: Partial<ActivityEventRow> = {}): ActivityEventRow {
  return {
    id: 42,
    ts: '2026-05-01T12:00:00Z',
    kind: 'delivery_submitted',
    requestId: 'req-42',
    serviceIndex: 1,
    txHash: '0xabc123def456',
    solverType: 'prediction.v1',
    outcome: 'ok',
    detail: null,
    credentialId: null,
    costUsdMicros: null,
    model: null,
    aiUnits: null,
    claimStatus: null,
    estimatedCostUsdMicros: null,
    actualCostUsdMicros: null,
    ...extra,
  };
}

function wrap(path: string): void {
  const { hook } = memoryLocation({ path });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <Route path="/events/:id"><EventDetailPage /></Route>
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getBootstrap).mockResolvedValue({ chain: 'base' } as never);
});

afterEach(() => {
  cleanup();
});

describe('<EventDetailPage />', () => {
  it('renders the plain-language summary before the payload', async () => {
    vi.mocked(api.getActivityEvent).mockResolvedValue(event());
    wrap('/events/42');

    await waitFor(() => {
      expect(screen.getByTestId('event-detail-summary')).toBeTruthy();
    });
    expect(screen.getByText(EVENT_KIND_META.delivery_submitted.description)).toBeTruthy();
    expect(screen.getByRole('heading', { name: EVENT_KIND_META.delivery_submitted.label })).toBeTruthy();
    expect(screen.getByTestId('event-detail-payload')).toBeTruthy();
    expect(
      screen.getByTestId('event-detail-summary').compareDocumentPosition(
        screen.getByTestId('event-detail-payload'),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('links txHash to the correct Basescan host for the active chain', async () => {
    vi.mocked(api.getActivityEvent).mockResolvedValue(event({ txHash: '0xdeadbeef' }));
    vi.mocked(api.getBootstrap).mockResolvedValue({ chain: 'base' } as never);
    wrap('/events/42');

    await waitFor(() => {
      expect(screen.getByTestId('event-detail-tx-link')).toBeTruthy();
    });
    expect(screen.getByTestId('event-detail-tx-link').getAttribute('href')).toBe(
      'https://basescan.org/tx/0xdeadbeef',
    );

    cleanup();
    vi.clearAllMocks();
    vi.mocked(api.getActivityEvent).mockResolvedValue(event({ txHash: '0xfeed' }));
    vi.mocked(api.getBootstrap).mockResolvedValue({ chain: 'base-sepolia' } as never);
    wrap('/events/42');
    await waitFor(() => {
      expect(screen.getByTestId('event-detail-tx-link')).toBeTruthy();
    });
    expect(screen.getByTestId('event-detail-tx-link').getAttribute('href')).toBe(
      'https://sepolia.basescan.org/tx/0xfeed',
    );
  });

  it('renders a non-snake_case label for every lifecycle kind', async () => {
    for (const kind of LIFECYCLE_KINDS) {
      vi.mocked(api.getActivityEvent).mockResolvedValue(event({ kind }));
      const { hook } = memoryLocation({ path: '/events/42' });
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { unmount } = render(
        <QueryClientProvider client={qc}>
          <Router hook={hook}>
            <Route path="/events/:id"><EventDetailPage /></Route>
          </Router>
        </QueryClientProvider>,
      );
      await waitFor(() => {
        expect(screen.getByText(EVENT_KIND_META[kind].label)).toBeTruthy();
      });
      unmount();
    }
  });

  it('shows a not-found state and exposes a back link', async () => {
    vi.mocked(api.getActivityEvent).mockRejectedValue(
      Object.assign(new Error('404 Not Found'), { status: 404 }),
    );
    wrap('/events/999');

    await waitFor(() => {
      expect(screen.getByTestId('event-detail-error')).toBeTruthy();
    });
    expect(screen.getByTestId('event-detail-back').getAttribute('href')).toBe('/events');
  });
});
