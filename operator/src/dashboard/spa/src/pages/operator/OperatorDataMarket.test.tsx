import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { JSX } from 'react';

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
    donation: { enabled: false },
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
      defaultPriceUsdc: '0',
      perArtifactTypePrice: { design_document: '0.002' },
      donation: { enabled: true },
    },
  });
});

describe('OperatorDataMarket', () => {
  it('renders a compact donation decision surface with a single execution data link', async () => {
    renderWithQueryClient(<OperatorDataMarket defaultExpanded />);

    await waitFor(() => expect(screen.getByTestId('operator-donation-status')).toBeTruthy());
    expect(screen.getByText(/share scrubbed and anonymized solver\/evaluator data from future runs/i)).toBeTruthy();
    expect(screen.getByText(/network learn from real executions and improve itself/i)).toBeTruthy();
    expect(screen.getByText('Eligible runs')).toBeTruthy();
    expect(screen.getByText('Peer datasets used')).toBeTruthy();
    expect(screen.queryByText('Scope')).toBeNull();
    expect(screen.getByText(/already published to IPFS may remain available/i)).toBeTruthy();
    expect(screen.queryByText('Scrubber')).toBeNull();
    expect(screen.queryByTestId('operator-artifact-list')).toBeNull();
    // "Review execution data" link removed — the Execution data sub-nav
    // entry is the canonical way to reach the surface now (the donation
    // card lives on that same route, so the in-card link was redundant).
    expect(screen.queryByRole('link', { name: /review execution data/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /show recent data/i })).toBeNull();
    expect(screen.queryByText('Execution data')).toBeNull();
    expect(screen.queryByText(/scrubbed execution artifacts become discoverable peer data/i)).toBeNull();
    expect(screen.queryByTestId('operator-donation-flow')).toBeNull();
    expect(screen.queryByTestId('operator-data-market-preview')).toBeNull();
    expect(screen.queryByTestId('operator-pricing-editor')).toBeNull();
    expect(screen.queryByLabelText(/default price/i)).toBeNull();
    expect(screen.queryByLabelText(/public endpoint/i)).toBeNull();
  });

  it('saves donation settings without exposing full pricing controls', async () => {
    const onRestartPending = vi.fn();
    renderWithQueryClient(
      <OperatorDataMarket defaultExpanded onRestartPending={onRestartPending} />,
    );

    await waitFor(() => expect(screen.getByTestId('operator-donation-status')).toBeTruthy());

    expect(screen.queryByLabelText(/price for design_document/i)).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: /donate produced data/i }));
    expect(screen.getByRole('alertdialog', { name: /share future execution data/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog', { name: /share future execution data/i })).toBeNull();
    expect(screen.getByTestId('operator-donation-mode').textContent).toBe('Donation is off');

    fireEvent.click(screen.getByRole('switch', { name: /donate produced data/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Enable donation' }));

    // write-through: mutation fires immediately on confirm — no Save click required
    await waitFor(() => expect(updatePricingMock).toHaveBeenCalled());
    expect(updatePricingMock).toHaveBeenCalledWith({
      publicEndpoint: 'https://op.example.com',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: { design_document: '0.002' },
      donation: { enabled: true },
    });
    await waitFor(() => expect(onRestartPending).toHaveBeenCalled());
  });

  it('persists the donation toggle on confirm without requiring Save (jinn-mono-hjex.10)', async () => {
    renderWithQueryClient(<OperatorDataMarket defaultExpanded />);

    await waitFor(() => expect(screen.getByTestId('operator-donation-status')).toBeTruthy());

    fireEvent.click(screen.getByRole('switch', { name: /donate produced data/i }));
    expect(screen.getByRole('alertdialog', { name: /share future execution data/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Enable donation' }));

    await waitFor(() => expect(updatePricingMock).toHaveBeenCalledWith(
      expect.objectContaining({ donation: expect.objectContaining({ enabled: true }) }),
    ));
    // mutation called — no Save button interaction needed
    expect(updatePricingMock).toHaveBeenCalledTimes(1);
  });

  it('reverts donation toggle to off when mutation fails (jinn-mono-hjex.10)', async () => {
    updatePricingMock.mockRejectedValue(new Error('network error'));
    renderWithQueryClient(<OperatorDataMarket defaultExpanded />);

    await waitFor(() => expect(screen.getByTestId('operator-donation-status')).toBeTruthy());

    expect(screen.getByTestId('operator-donation-mode').textContent).toBe('Donation is off');
    fireEvent.click(screen.getByRole('switch', { name: /donate produced data/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Enable donation' }));

    // optimistic toggle shows "on" immediately
    expect(screen.getByTestId('operator-donation-mode').textContent).toBe('Donation is on');

    // after failure, reverts to "off"
    await waitFor(() =>
      expect(screen.getByTestId('operator-donation-mode').textContent).toBe('Donation is off'),
    );
  });

});
