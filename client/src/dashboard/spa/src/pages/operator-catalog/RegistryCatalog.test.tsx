import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { JSX } from 'react';

/**
 * Tests for the operator-side registry catalog. Each test mocks
 * `api.solvernets.listRegistry` per its scenario; the dynamic-import dance
 * mirrors `Overview.test.tsx` so the mock takes effect before the component
 * picks up the api module.
 */

const listRegistryMock = vi.fn();

vi.mock('../../api/client.js', () => ({
  api: {
    operator: {
    },
    solvernets: {
      listRegistry: () => listRegistryMock(),
    },
  },
}));

const { RegistryCatalog } = await import('./RegistryCatalog.js');

function withProviders(node: JSX.Element, path = '/operator'): JSX.Element {
  const { hook } = memoryLocation({ path });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <Router hook={hook}>{node}</Router>
    </QueryClientProvider>
  );
}

describe('RegistryCatalog', () => {
  beforeEach(() => {
    listRegistryMock.mockReset();
  });

  it('shows the spec §12 empty-state copy when no SolverNets are launched', async () => {
    listRegistryMock.mockResolvedValue({
      summaries: [],
      lastRefreshedAt: null,
      lastError: null,
    });
    render(withProviders(<RegistryCatalog />));
    await waitFor(() =>
      expect(screen.getByTestId('registry-catalog-empty')).toBeTruthy(),
    );
    expect(
      screen.getByText(/no launched solvernets available\./i),
    ).toBeTruthy();
  });

  it('renders one card per registry summary with status badges and prices', async () => {
    listRegistryMock.mockResolvedValue({
      summaries: [
        {
          manifestCid: 'bafybeiaaa',
          solverNetId: 'agent5474_prediction.v1-1_aaaaaaaa',
          name: 'Prediction Markets',
          network: 'base-sepolia',
          launcherAgentId: '5474',
          launcherSafeAddress: '0xE64bAfABCDEF0123456789abcdef0123456789B5CF',
          status: 'launched',
          statusUpdatedAt: '2026-05-05T00:00:00Z',
          contractId: 'prediction',
          contractVersion: 'v1',
          solutionPriceWei: '1000000000000000', // 0.001 ETH
          verdictPriceWei: '500000000000000', // 0.0005 ETH
          openRoles: ['solver', 'evaluator'],
          anchorBlock: 1,
        },
        {
          manifestCid: 'bafybeibbb',
          solverNetId: 'agent9999_prediction.v1-1_bbbbbbbb',
          name: 'Sports Prediction',
          network: 'base-sepolia',
          launcherAgentId: '9999',
          launcherSafeAddress: '0xAA112233445566778899AABBCCDDEEFF11223344',
          status: 'paused',
          statusUpdatedAt: '2026-05-05T00:00:00Z',
          contractId: 'prediction',
          contractVersion: 'v1',
          solutionPriceWei: '2000000000000000',
          verdictPriceWei: '1000000000000000',
          openRoles: ['solver'],
          anchorBlock: 2,
        },
        {
          manifestCid: 'bafybeiccc',
          solverNetId: 'agent1234_prediction.v1-1_cccccccc',
          name: 'Retired Net',
          network: 'base-sepolia',
          launcherAgentId: '1234',
          launcherSafeAddress: '0x0000000000000000000000000000000000000000',
          status: 'retired',
          statusUpdatedAt: '2026-05-05T00:00:00Z',
          contractId: 'prediction',
          contractVersion: 'v1',
          solutionPriceWei: '1000000000000000',
          verdictPriceWei: '500000000000000',
          openRoles: [],
          anchorBlock: 3,
        },
      ],
      lastRefreshedAt: '2026-05-05T01:00:00Z',
      lastError: null,
    });
    render(withProviders(<RegistryCatalog />));
    await waitFor(() =>
      expect(screen.queryAllByTestId('registry-card')).toHaveLength(3),
    );

    expect(screen.getByText('Prediction Markets')).toBeTruthy();
    expect(screen.getByText('Sports Prediction')).toBeTruthy();
    expect(screen.getByText('Retired Net')).toBeTruthy();

    // Status badges reflect each summary's status verbatim.
    const badges = screen.getAllByTestId('registry-status-badge');
    expect(badges.map((b) => b.getAttribute('data-status'))).toEqual([
      'launched',
      'paused',
      'retired',
    ]);

    // Open-role chips render for the launched + paused entries.
    const roleChips = screen.getAllByTestId('registry-open-role');
    expect(roleChips.length).toBeGreaterThanOrEqual(3);
  });

  it('renders an enrichment-pending (degraded) row alongside an enriched one without crashing', async () => {
    // Issue #985: the daemon now lists every chain-matched row from the
    // indexer instead of silently skipping rows whose manifest could not be
    // fetched/verified from IPFS. A row the indexer has not enriched yet
    // (or an old indexer omits) passes through "degraded-but-present":
    // empty name, '0' prices, zero launcher address, empty openRoles.
    // The catalog must render such a row acceptably — no crash, no NaN, no
    // broken layout — beside a fully-enriched row.
    listRegistryMock.mockResolvedValue({
      summaries: [
        {
          // Fully enriched row.
          manifestCid: 'bafybeienriched',
          solverNetId: 'agent5474_prediction.v1-1_aaaaaaaa',
          name: 'Prediction Markets',
          network: 'base-sepolia',
          launcherAgentId: '5474',
          launcherSafeAddress: '0xE64bAfABCDEF0123456789abcdef0123456789B5CF',
          status: 'launched',
          statusUpdatedAt: '2026-05-05T00:00:00Z',
          contractId: 'prediction',
          contractVersion: 'v1',
          solutionPriceWei: '1000000000000000', // 0.001 ETH
          verdictPriceWei: '500000000000000', // 0.0005 ETH
          openRoles: ['solver', 'evaluator'],
          anchorBlock: 1,
        },
        {
          // Enrichment-pending row — the exact degraded shape #985 emits:
          // empty name, sentinel '0' prices, zero launcher address, empty
          // openRoles. launcherAgentId + status pass through from the chain.
          manifestCid: 'bafybeipending',
          solverNetId: 'bafybeipending', // falls back to cid when not enriched
          name: '',
          network: '',
          launcherAgentId: '9999',
          launcherSafeAddress: '0x0000000000000000000000000000000000000000',
          status: 'launched',
          statusUpdatedAt: '2026-05-05T00:00:00Z',
          contractId: '',
          contractVersion: '',
          solutionPriceWei: '0',
          verdictPriceWei: '0',
          openRoles: [],
          anchorBlock: 2,
        },
      ],
      lastRefreshedAt: '2026-05-05T01:00:00Z',
      lastError: null,
    });
    render(withProviders(<RegistryCatalog />));

    // Both rows render — the degraded one is present, not silently dropped.
    await waitFor(() =>
      expect(screen.queryAllByTestId('registry-card')).toHaveLength(2),
    );

    const cards = screen.getAllByTestId('registry-card');
    const enrichedCard = cards.find(
      (c) => c.getAttribute('data-manifest-cid') === 'bafybeienriched',
    )!;
    const pendingCard = cards.find(
      (c) => c.getAttribute('data-manifest-cid') === 'bafybeipending',
    )!;
    expect(enrichedCard).toBeTruthy();
    expect(pendingCard).toBeTruthy();

    // The enriched row is unaffected — real name shown, not the placeholder.
    expect(enrichedCard.textContent).toContain('Prediction Markets');
    expect(enrichedCard.textContent).not.toContain('Metadata pending');

    // Degraded row: the empty name renders the operator-plain placeholder
    // instead of a blank title span.
    expect(pendingCard.textContent).toContain('Metadata pending');

    // Degraded row: '0' wei prices format as a clean "0 ETH" — never NaN /
    // undefined / scientific notation.
    expect(pendingCard.textContent).toContain('0 ETH');
    expect(pendingCard.textContent).not.toMatch(/NaN/);
    expect(pendingCard.textContent).not.toMatch(/undefined/);
    expect(pendingCard.textContent).not.toMatch(/\de[-+]\d/); // no 5e-9 etc.

    // Empty openRoles degrades to the explicit "no open roles" copy rather
    // than an empty chip strip.
    expect(pendingCard.textContent).toContain('no open roles');

    // The zero launcher address is truncated, not rendered raw or as a blank.
    expect(pendingCard.textContent).toContain('0x0000…0000');
    // launcherAgentId still passes through from the chain row.
    expect(pendingCard.textContent).toContain('9999');

    // Status badge still renders for the degraded row (chain-sourced status).
    const pendingBadge = pendingCard.querySelector(
      '[data-testid="registry-status-badge"]',
    );
    expect(pendingBadge?.getAttribute('data-status')).toBe('launched');
  });

  it('formats tiny live prices as gwei instead of scientific ETH notation', async () => {
    listRegistryMock.mockResolvedValue({
      summaries: [
        {
          manifestCid: 'bafybeiaaa',
          solverNetId: 'agent5474_swe-rebench-v2-v1_aaaaaaaa',
          name: 'SWE-rebench v2',
          network: 'base-sepolia',
          launcherAgentId: '5474',
          launcherSafeAddress: '0xE64bAfABCDEF0123456789abcdef0123456789B5CF',
          status: 'launched',
          statusUpdatedAt: '2026-05-05T00:00:00Z',
          contractId: 'swe-rebench-v2',
          contractVersion: 'v1',
          solutionPriceWei: '10000000000',
          verdictPriceWei: '5000000000',
          openRoles: ['solver', 'evaluator'],
          anchorBlock: 1,
        },
      ],
      lastRefreshedAt: null,
      lastError: null,
    });

    render(withProviders(<RegistryCatalog />));

    await waitFor(() =>
      expect(screen.getByText('SWE-rebench v2')).toBeTruthy(),
    );
    expect(screen.getByText('10 gwei')).toBeTruthy();
    expect(screen.getByText('5 gwei')).toBeTruthy();
    expect(screen.queryByText(/\d\.\d+e-/i)).toBeNull();
  });

  it('shows a loading state while the query resolves', () => {
    // Never-resolving promise keeps the query pending.
    listRegistryMock.mockReturnValue(new Promise(() => undefined));
    render(withProviders(<RegistryCatalog />));
    expect(screen.getByTestId('registry-catalog-loading')).toBeTruthy();
  });

  it('shows an error banner with retry when the query fails', async () => {
    listRegistryMock.mockRejectedValue(new Error('upstream subgraph error'));
    render(withProviders(<RegistryCatalog />));
    await waitFor(() =>
      expect(screen.getByTestId('registry-catalog-error')).toBeTruthy(),
    );
    expect(screen.getByText(/upstream subgraph error/i)).toBeTruthy();
    expect(screen.getByTestId('registry-catalog-retry')).toBeTruthy();
  });

  it('explains subsystem_not_ready registry errors as startup lag', async () => {
    listRegistryMock.mockRejectedValue(
      Object.assign(new Error('503 Service Unavailable: SolverNet subsystem still initialising'), {
        status: 503,
        code: 'subsystem_not_ready',
      }),
    );

    render(withProviders(<RegistryCatalog />));

    await waitFor(() =>
      expect(screen.getByText(/solvernet subsystem is still starting/i)).toBeTruthy(),
    );
    expect(screen.getByText(/wait a few seconds, then retry/i)).toBeTruthy();
  });

  it('explains registry_unavailable errors as registry cache failures', async () => {
    listRegistryMock.mockRejectedValue(
      Object.assign(new Error('503 Service Unavailable: registry_unavailable'), {
        status: 503,
        code: 'registry_unavailable',
      }),
    );

    render(withProviders(<RegistryCatalog />));

    await waitFor(() =>
      expect(screen.getByText(/registry cache is unavailable/i)).toBeTruthy(),
    );
    expect(screen.getByText(/check daemon logs/i)).toBeTruthy();
  });

  it('surfaces lastRefreshedAt and lastError from the response envelope', async () => {
    listRegistryMock.mockResolvedValue({
      summaries: [],
      lastRefreshedAt: '2026-05-05T01:23:00Z',
      lastError: { message: 'subgraph 502', at: '2026-05-05T01:24:00Z' },
    });
    render(withProviders(<RegistryCatalog />));
    await waitFor(() =>
      expect(screen.getByTestId('registry-catalog-meta')).toBeTruthy(),
    );
    expect(screen.getByTestId('registry-catalog-meta').textContent).toContain(
      '2026-05-05',
    );
    expect(screen.getByTestId('registry-catalog-warn').textContent).toContain(
      'subgraph 502',
    );
  });

  it('surfaces a rate-limited RPC distinctly in the stale-warning row', async () => {
    // jinn-mono #325: when the catalog refresh fails because the RPC is
    // throttled, the stale indicator must show an operator-actionable line
    // with a deep-link to Network settings, not a generic "stale (...)".
    listRegistryMock.mockResolvedValue({
      summaries: [],
      lastRefreshedAt: '2026-05-05T01:23:00Z',
      lastError: {
        message: 'OnchainDiscoveryAPI: getLogs for MetadataSet failed',
        at: '2026-05-05T01:24:00Z',
        code: 'rpc_rate_limited',
      },
    });
    render(withProviders(<RegistryCatalog />));
    await waitFor(() =>
      expect(screen.getByTestId('registry-catalog-warn')).toBeTruthy(),
    );
    const warn = screen.getByTestId('registry-catalog-warn');
    expect(warn.getAttribute('data-error-code')).toBe('rpc_rate_limited');
    expect(warn.textContent).toMatch(/rpc rate-limited — add your own key/i);
    // Does NOT fall back to the generic "stale (...)" string.
    expect(warn.textContent).not.toMatch(/^stale \(/i);
    // Deep-links to the Network settings section.
    const action = screen.getByTestId('registry-catalog-warn-action');
    expect(action.getAttribute('href')).toBe('/operator#network');
  });

  it('explains rpc_rate_limited query errors with a BYO-RPC nudge', async () => {
    listRegistryMock.mockRejectedValue(
      Object.assign(new Error('rpc_rate_limited: 429 Too Many Requests'), {
        code: 'rpc_rate_limited',
      }),
    );

    render(withProviders(<RegistryCatalog />));

    await waitFor(() =>
      expect(screen.getByTestId('registry-catalog-error')).toBeTruthy(),
    );
    expect(screen.getByText(/your rpc endpoint is rate-limited/i)).toBeTruthy();
    expect(
      screen.getByText(/open the network section and add your own free key/i),
    ).toBeTruthy();
    const action = screen.getByTestId('registry-catalog-error-action');
    expect(action.getAttribute('href')).toBe('/operator#network');
  });

  // #1240 — the running swe-rebench-v2 net is the first-run demo target.
  function summary(
    overrides: Partial<{
      manifestCid: string;
      name: string;
      contractId: string;
      status: 'launched' | 'paused' | 'retired';
    }>,
  ) {
    return {
      manifestCid: 'bafybeidefault',
      solverNetId: 'agent5474_prediction.v1-1_default',
      name: 'A Net',
      network: 'base-sepolia',
      launcherAgentId: '5474',
      launcherSafeAddress: '0xE64bAfABCDEF0123456789abcdef0123456789B5CF',
      status: 'launched',
      statusUpdatedAt: '2026-05-05T00:00:00Z',
      contractId: 'prediction',
      contractVersion: 'v1',
      solutionPriceWei: '10000000000',
      verdictPriceWei: '5000000000',
      openRoles: ['solver', 'evaluator'],
      anchorBlock: 1,
      ...overrides,
    };
  }

  it('hoists the canonical swe-rebench-v2 demo net to the first card', async () => {
    listRegistryMock.mockResolvedValue({
      summaries: [
        summary({ manifestCid: 'bafybeipred', name: 'Prediction Markets', contractId: 'prediction' }),
        summary({ manifestCid: 'bafybeidemo', name: 'SWE-rebench v2', contractId: 'swe-rebench-v2' }),
        summary({ manifestCid: 'bafybeiother', name: 'Another Prediction', contractId: 'prediction' }),
      ],
      lastRefreshedAt: null,
      lastError: null,
    });
    render(withProviders(<RegistryCatalog />));
    await waitFor(() =>
      expect(screen.queryAllByTestId('registry-card')).toHaveLength(3),
    );
    const first = screen.getAllByTestId('registry-card')[0];
    expect(first.getAttribute('data-manifest-cid')).toBe('bafybeidemo');
  });

  it('badges the canonical demo net as Recommended demo', async () => {
    listRegistryMock.mockResolvedValue({
      summaries: [
        summary({ manifestCid: 'bafybeidemo', name: 'SWE-rebench v2', contractId: 'swe-rebench-v2' }),
        summary({ manifestCid: 'bafybeipred', name: 'Prediction Markets', contractId: 'prediction' }),
      ],
      lastRefreshedAt: null,
      lastError: null,
    });
    render(withProviders(<RegistryCatalog />));
    await waitFor(() =>
      expect(screen.queryAllByTestId('registry-card')).toHaveLength(2),
    );
    const cards = screen.getAllByTestId('registry-card');
    const demoCard = cards.find(
      (c) => c.getAttribute('data-manifest-cid') === 'bafybeidemo',
    )!;
    const predCard = cards.find(
      (c) => c.getAttribute('data-manifest-cid') === 'bafybeipred',
    )!;
    const badge = demoCard.querySelector(
      '[data-testid="registry-card-recommended"]',
    );
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toMatch(/recommended demo/i);
    expect(
      predCard.querySelector('[data-testid="registry-card-recommended"]'),
    ).toBeNull();
  });

  it('badges the canonical demo net as recommended', async () => {
    listRegistryMock.mockResolvedValue({
      summaries: [
        summary({ manifestCid: 'bafybeidemo', name: 'SWE-rebench v2', contractId: 'swe-rebench-v2' }),
        summary({ manifestCid: 'bafybeipred', name: 'Prediction Markets', contractId: 'prediction' }),
      ],
      lastRefreshedAt: null,
      lastError: null,
    });
    render(withProviders(<RegistryCatalog />));
    await waitFor(() =>
      expect(screen.queryAllByTestId('registry-card')).toHaveLength(2),
    );
    const cards = screen.getAllByTestId('registry-card');
    const demoCard = cards.find(
      (c) => c.getAttribute('data-manifest-cid') === 'bafybeidemo',
    )!;
    const predCard = cards.find(
      (c) => c.getAttribute('data-manifest-cid') === 'bafybeipred',
    )!;
    expect(demoCard.querySelector('[data-testid="registry-card-recommended"]')).toBeTruthy();
    expect(predCard.querySelector('[data-testid="registry-card-recommended"]')).toBeNull();
  });

  it('excludes smoke / internal nets from Discover', async () => {
    listRegistryMock.mockResolvedValue({
      summaries: [
        summary({ manifestCid: 'bafybeidemo', name: 'SWE-rebench v2', contractId: 'swe-rebench-v2' }),
        summary({ manifestCid: 'bafybeismoke', name: 'smoke-e2e-throwaway', contractId: 'prediction' }),
      ],
      lastRefreshedAt: null,
      lastError: null,
    });
    render(withProviders(<RegistryCatalog />));
    await waitFor(() =>
      expect(screen.queryAllByTestId('registry-card')).toHaveLength(1),
    );
    const cards = screen.getAllByTestId('registry-card');
    expect(cards[0].getAttribute('data-manifest-cid')).toBe('bafybeidemo');
    expect(screen.queryByText(/smoke-e2e-throwaway/i)).toBeNull();
    expect(screen.getByTestId('registry-catalog-meta').textContent).toContain(
      '1 discoverable',
    );
  });

  it('keeps non-canonical launched nets visible after the demo net', async () => {
    listRegistryMock.mockResolvedValue({
      summaries: [
        summary({ manifestCid: 'bafybeipred', name: 'Prediction Markets', contractId: 'prediction' }),
        summary({ manifestCid: 'bafybeidemo', name: 'SWE-rebench v2', contractId: 'swe-rebench-v2' }),
      ],
      lastRefreshedAt: null,
      lastError: null,
    });
    render(withProviders(<RegistryCatalog />));
    await waitFor(() =>
      expect(screen.queryAllByTestId('registry-card')).toHaveLength(2),
    );
    const cards = screen.getAllByTestId('registry-card');
    expect(cards.map((c) => c.getAttribute('data-manifest-cid'))).toEqual([
      'bafybeidemo',
      'bafybeipred',
    ]);
    expect(screen.getByText('Prediction Markets')).toBeTruthy();
  });

  it('does not treat the canonical demo net as internal even if unusual', async () => {
    listRegistryMock.mockResolvedValue({
      summaries: [
        summary({ manifestCid: 'bafybeidemo', name: 'smoke SWE-rebench v2', contractId: 'swe-rebench-v2' }),
      ],
      lastRefreshedAt: null,
      lastError: null,
    });
    render(withProviders(<RegistryCatalog />));
    await waitFor(() =>
      expect(screen.queryAllByTestId('registry-card')).toHaveLength(1),
    );
    const card = screen.getAllByTestId('registry-card')[0];
    expect(card.getAttribute('data-manifest-cid')).toBe('bafybeidemo');
    expect(
      card.querySelector('[data-testid="registry-card-recommended"]'),
    ).toBeTruthy();
  });
});
