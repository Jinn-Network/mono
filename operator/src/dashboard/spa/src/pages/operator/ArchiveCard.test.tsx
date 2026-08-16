import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { JSX, ReactNode } from 'react';
import { ArchiveCard } from './ArchiveCard.js';
import { api } from '../../api/client.js';

vi.mock('../../api/client.js', () => ({
  api: { getStatus: vi.fn() },
}));

function withQuery(node: ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const getStatus = vi.mocked(api.getStatus);

function statusWith(evidenceIndexing: unknown): void {
  getStatus.mockResolvedValue({ evidenceIndexing } as never);
}

beforeEach(() => {
  getStatus.mockReset();
});

describe('ArchiveCard', () => {
  it('always states the IP disclosure and the mirror alternative (safety copy)', async () => {
    statusWith({ failures: [], pending: 0 });
    render(withQuery(<ArchiveCard />));
    expect(await screen.findByText(/IP address/i)).toBeTruthy();
    expect(screen.getByText(/mirror or static host/i)).toBeTruthy();
  });

  it('reports a clean driver as all records indexed', async () => {
    statusWith({ failures: [], pending: 0 });
    render(withQuery(<ArchiveCard />));
    expect(await screen.findByText(/all records indexed/i)).toBeTruthy();
  });

  it('reports records waiting to index', async () => {
    statusWith({ failures: [], pending: 3 });
    render(withQuery(<ArchiveCard />));
    expect(await screen.findByText(/3 records waiting to index/i)).toBeTruthy();
  });

  it('raises the degraded alert with the failure message when the driver has failures', async () => {
    statusWith({
      failures: [{ reference: 'sha256:abc', category: 'index_failed', message: 'head re-sign rejected' }],
      pending: 1,
    });
    render(withQuery(<ArchiveCard />));
    expect(await screen.findByTestId('archive-indexing-degraded')).toBeTruthy();
    expect(screen.getByText(/head re-sign rejected/i)).toBeTruthy();
    expect(screen.getByText(/retries automatically/i)).toBeTruthy();
  });

  it('renders an explicit zero-state, never a blank panel, when indexing is absent', async () => {
    statusWith(undefined);
    render(withQuery(<ArchiveCard />));
    expect(await screen.findByText(/no indexing activity yet/i)).toBeTruthy();
  });
});
