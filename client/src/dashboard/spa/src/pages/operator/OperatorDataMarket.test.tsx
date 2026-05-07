import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const listArtifactsMock = vi.fn();
const updatePricingMock = vi.fn();

vi.mock('../../api/client.js', () => ({
  api: {
    operator: {
      listArtifacts: (...args: unknown[]) => listArtifactsMock(...args),
      updatePricing: (...args: unknown[]) => updatePricingMock(...args),
    },
  },
}));

const { OperatorDataMarket } = await import('./OperatorDataMarket.js');

const servedResponse = {
  schemaVersion: 1,
  generatedAt: '2026-05-07T12:00:00.000Z',
  source: 'served',
  pricing: {
    publicEndpoint: 'https://op.example.com',
    defaultPriceUsdc: '0',
    perArtifactTypePrice: { design_document: '0.002' },
  },
  summary: {
    served: {
      totalCount: 1,
      totalBytes: 13,
      freeCount: 0,
      gatedCount: 1,
      latestCreatedAt: '2026-05-07T10:00:00.000Z',
      artifactTypes: [{ artifactType: 'design_document', count: 1, totalBytes: 13, gatedCount: 1 }],
    },
    network: {
      totalCount: 0,
      totalBytes: 0,
      latestFetchedAt: null,
      artifactTypes: [],
    },
    access: {
      accessCount: 3,
      paidServeCount: 1,
      freeServeCount: 0,
      failedPaymentCount: 1,
      paymentRequiredCount: 1,
      revenueUsdc: '0.002',
      lastAccessAt: '2026-05-07T10:05:00.000Z',
      lastPaidAt: '2026-05-07T10:04:00.000Z',
    },
  },
  recentAccesses: [],
  artifacts: [
    {
      source: 'served',
      sha256: 'a'.repeat(64),
      artifactType: 'design_document',
      requestId: 'req-1',
      envelopeCid: 'bafy-envelope',
      contentSize: 13,
      priceUsdc: '0.002',
      createdAt: '2026-05-07T10:00:00.000Z',
      endpoint: `https://op.example.com/v1/artifacts/${'a'.repeat(64)}/content`,
      access: {
        accessCount: 3,
        paidServeCount: 1,
        freeServeCount: 0,
        failedPaymentCount: 1,
        paymentRequiredCount: 1,
        revenueUsdc: '0.002',
        lastAccessAt: '2026-05-07T10:05:00.000Z',
        lastPaidAt: '2026-05-07T10:04:00.000Z',
      },
    },
  ],
};

function renderWithQueryClient(node: JSX.Element): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  listArtifactsMock.mockReset();
  updatePricingMock.mockReset();
  listArtifactsMock.mockResolvedValue(servedResponse);
  updatePricingMock.mockResolvedValue({
    ok: true,
    restartRequired: true,
    pricing: {
      publicEndpoint: 'https://op.example.com',
      defaultPriceUsdc: '0.001',
      perArtifactTypePrice: { design_document: '0.002' },
    },
  });
});

describe('OperatorDataMarket', () => {
  it('renders served artifact inventory and expanded row details', async () => {
    renderWithQueryClient(<OperatorDataMarket defaultExpanded />);

    await waitFor(() => expect(screen.getByTestId('operator-data-market')).toBeTruthy());
    const list = screen.getByTestId('operator-artifact-list');
    expect(within(list).getByText('design_document')).toBeTruthy();
    expect(screen.getAllByText('$0.002').length).toBeGreaterThan(0);
    expect(screen.getByText(/3 accesses/i)).toBeTruthy();
    expect(screen.getByText(/1 served/i)).toBeTruthy();

    fireEvent.click(within(list).getByText('design_document'));

    expect(screen.getByTestId('operator-artifact-details')).toBeTruthy();
    expect(screen.getByText('bafy-envelope')).toBeTruthy();
    expect(screen.getByText('req-1')).toBeTruthy();
    expect(screen.getByText(/3 total · 1 paid · 1 failed/i)).toBeTruthy();
  });

  it('saves future-artifact pricing and signals restart', async () => {
    const onRestartPending = vi.fn();
    renderWithQueryClient(
      <OperatorDataMarket defaultExpanded onRestartPending={onRestartPending} />,
    );

    await waitFor(() => expect(screen.getByTestId('operator-pricing-editor')).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/default price/i), {
      target: { value: '0.001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save pricing' }));

    await waitFor(() => expect(updatePricingMock).toHaveBeenCalled());
    expect(updatePricingMock).toHaveBeenCalledWith({
      publicEndpoint: 'https://op.example.com',
      defaultPriceUsdc: '0.001',
      perArtifactTypePrice: { design_document: '0.002' },
    });
    await waitFor(() => expect(onRestartPending).toHaveBeenCalled());
  });
});
