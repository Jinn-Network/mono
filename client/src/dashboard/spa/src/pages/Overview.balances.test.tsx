import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

/**
 * Issue #430 — assert that the per-role ETH wei strings exposed on
 * /v1/status flow through `Overview.tsx`'s data path into the
 * `WalletCard.perRole` prop (master / agent / Safe), formatted via
 * `formatEth`. The WalletCard drill-down UI is currently hidden
 * (WalletCard.tsx:41-49), so a DOM-only assertion would falsely pass —
 * mock WalletCard and capture the `perRole` prop.
 */

const getStatusMock = vi.fn();
const getBootstrapMock = vi.fn();

// Mock the data layer. `getSolverNets` mirrors the existing Overview.test
// shape (catalog query failure is tolerated by the page).
vi.mock('../api/client.js', () => ({
  api: {
    getStatus: () => getStatusMock(),
    getBootstrap: () => getBootstrapMock(),
    getSolverNets: () => Promise.resolve({ nets: [] }),
    triggerDrip: vi.fn(),
    stopDaemon: vi.fn(),
    restartDaemon: vi.fn(),
    retryAgentBinding: vi.fn(),
  },
}));

// Spy on WalletCard to capture the `perRole` prop. We render the captured
// object as JSON inside the test container so the assertion is a simple
// substring check, independent of the WalletCard's real DOM.
vi.mock('./overview/WalletCard.js', () => ({
  WalletCard: (props: { perRole?: { master: string; agent: string; safe: string } }) => (
    <div data-testid="wallet-card-mock">{JSON.stringify(props.perRole)}</div>
  ),
}));

// Import after the mocks so the page picks up the mocked client and WalletCard.
const { OverviewPage } = await import('./Overview.js');

beforeEach(() => {
  getStatusMock.mockReset();
  getBootstrapMock.mockReset();
  getBootstrapMock.mockResolvedValue({});
});

function renderOverview(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { hook } = memoryLocation({ path: '/overview' });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <OverviewPage />
      </Router>
    </QueryClientProvider>,
  );
}

describe('Overview — per-role ETH wiring (#430)', () => {
  it('passes the formatted per-role strings into WalletCard.perRole', async () => {
    getStatusMock.mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete', serviceId: 42, safeAddress: '0xSafe' }] },
      masterGas: { balanceWei: '7000000000000000' },
      balances: {
        eth: {
          master: { balanceWei: '7000000000000000' }, // 0.0070
          agent:  { balanceWei: '2500000000000000' }, // 0.0025
          safe:   { balanceWei: '4000000000000000' }, // 0.0040
        },
      },
    });
    renderOverview();
    await waitFor(() => {
      const captured = document.querySelector('[data-testid="wallet-card-mock"]')?.textContent ?? '';
      expect(captured).toContain('"master":"0.0070"');
      expect(captured).toContain('"agent":"0.0025"');
      expect(captured).toContain('"safe":"0.0040"');
    });
  });

  it('falls back to "—" for each role when /v1/status omits balances.eth', async () => {
    getStatusMock.mockResolvedValue({
      fleet: { services: [] },
      masterGas: {},
    });
    renderOverview();
    await waitFor(() => {
      const captured = document.querySelector('[data-testid="wallet-card-mock"]')?.textContent ?? '';
      expect(captured).toContain('"master":"—"');
      expect(captured).toContain('"agent":"—"');
      expect(captured).toContain('"safe":"—"');
    });
  });
});
