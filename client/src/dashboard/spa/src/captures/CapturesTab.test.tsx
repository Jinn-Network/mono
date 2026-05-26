import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const approveMock = vi.fn();
const skipMock = vi.fn();
const trustRepoMock = vi.fn();
const listPendingMock = vi.fn();
const listArtifactsMock = vi.fn();

vi.mock('../api/client.js', () => ({
  api: {
    captures: {
      listPending: () => listPendingMock(),
      get: async () => ({
        capture: {
          sessionId: 'sess-1',
          capturedAt: '2026-05-08T00:00:00.000Z',
          originatingTool: { name: 'claude-code', version: '1.0.0' },
          capturePath: 'B',
          status: 'pending',
          spanCount: 1,
          durationMs: 10,
          redactedSpanCount: 1,
          repoRemoteUrl: 'git@example.com:repo.git',
          repoCommitHash: 'a'.repeat(40),
        },
        spans: [{
          sessionId: 'sess-1',
          spanId: 'b'.repeat(16),
          traceId: 'c'.repeat(32),
          parentSpanId: null,
          name: 'user-message',
          startTimeUnixNano: '1',
          endTimeUnixNano: '2',
          attributes: {},
          redactedKeys: ['http.request.header.authorization'],
        }],
      }),
      approve: approveMock,
      skip: skipMock,
      trustRepo: trustRepoMock,
    },
    operator: {
      listArtifacts: (...args: unknown[]) => listArtifactsMock(...args),
    },
  },
}));

const { CapturesTab } = await import('./CapturesTab.js');

function renderTab(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CapturesTab />
    </QueryClientProvider>,
  );
}

describe('CapturesTab', () => {
  beforeEach(() => {
    approveMock.mockReset();
    skipMock.mockReset();
    trustRepoMock.mockReset();
    listPendingMock.mockReset();
    listArtifactsMock.mockReset();
  });

  it('renders execution data and exposes approve/skip/trust actions', async () => {
    listPendingMock.mockResolvedValue({
      captures: [{
        sessionId: 'sess-1',
        capturedAt: '2026-05-08T00:00:00.000Z',
        originatingTool: { name: 'claude-code', version: '1.0.0' },
        capturePath: 'B',
        status: 'pending',
        spanCount: 1,
        durationMs: 10,
        redactedSpanCount: 1,
        repoRemoteUrl: 'git@example.com:repo.git',
        repoCommitHash: 'a'.repeat(40),
      }],
    });
    approveMock.mockResolvedValue({ ok: true, sessionId: 'sess-1', envelopeCid: 'bafy', publishedAt: 'now' });
    skipMock.mockResolvedValue({ ok: true, sessionId: 'sess-1', skippedAt: 'now' });
    trustRepoMock.mockResolvedValue({ ok: true, repoRemoteUrl: 'git@example.com:repo.git', trusted: true });
    listArtifactsMock.mockImplementation((opts: { source?: string }) => Promise.resolve({
      schemaVersion: 1,
      generatedAt: '2026-05-08T00:00:00.000Z',
      source: opts.source ?? 'served',
      pricing: {
        publicEndpoint: '',
        defaultPriceUsdc: '0',
        perArtifactTypePrice: {},
        donation: { enabled: true },
      },
      summary: {
        served: {
          totalCount: opts.source === 'served' ? 1 : 0,
          totalBytes: opts.source === 'served' ? 13 : 0,
          freeCount: 1,
          gatedCount: 0,
          latestCreatedAt: null,
          artifactTypes: [],
        },
        network: {
          totalCount: 0,
          totalBytes: 0,
          latestFetchedAt: null,
          artifactTypes: [],
        },
        access: {
          accessCount: 0,
          paidServeCount: 0,
          freeServeCount: 0,
          failedPaymentCount: 0,
          paymentRequiredCount: 0,
          revenueUsdc: '0',
          lastAccessAt: null,
          lastPaidAt: null,
        },
      },
      recentAccesses: [],
      artifacts: opts.source === 'served'
        ? [{
            source: 'served',
            sha256: 'a'.repeat(64),
            artifactType: 'swe-rebench-v2_v1_solution',
            requestId: 'req-1',
            envelopeCid: 'bafy-solution',
            contentSize: 13,
            priceUsdc: '0',
            createdAt: '2026-05-07T00:00:00.000Z',
            endpoint: null,
            access: {
              accessCount: 0,
              paidServeCount: 0,
              freeServeCount: 0,
              failedPaymentCount: 0,
              paymentRequiredCount: 0,
              revenueUsdc: '0',
              lastAccessAt: null,
              lastPaidAt: null,
            },
            anchors: [],
          }]
        : [],
    }));

    renderTab();

    expect(screen.getByText('Execution data')).toBeTruthy();
    // Both list rows render in the Card.
    expect(await screen.findByText('swe-rebench-v2_v1_solution')).toBeTruthy();
    expect(await screen.findByText('execution-capture.v1')).toBeTruthy();

    // Detail surface is now a Sheet drawer — opens on row activation.
    fireEvent.click(screen.getByText('execution-capture.v1'));

    // sess-1 appears in both the Sheet title and the drill-in h1.
    expect((await screen.findAllByText('sess-1')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByText('user-message').length).toBeGreaterThan(0));
    expect(screen.getByText('http.request.header.authorization')).toBeTruthy();

    fireEvent.click(screen.getByText('Trust repo'));
    await waitFor(() => expect(trustRepoMock).toHaveBeenCalledWith('git@example.com:repo.git', true));

    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith('sess-1'));
  });

  it('surfaces permission errors instead of falling back to an empty state', async () => {
    listPendingMock.mockRejectedValue(new Error('401 Unauthorized on /api/captures/pending'));
    listArtifactsMock.mockResolvedValue({
      schemaVersion: 1,
      generatedAt: '2026-05-08T00:00:00.000Z',
      source: 'served',
      pricing: {
        publicEndpoint: '',
        defaultPriceUsdc: '0',
        perArtifactTypePrice: {},
        donation: { enabled: true },
      },
      summary: {
        served: { totalCount: 0, totalBytes: 0, freeCount: 0, gatedCount: 0, latestCreatedAt: null, artifactTypes: [] },
        network: { totalCount: 0, totalBytes: 0, latestFetchedAt: null, artifactTypes: [] },
        access: {
          accessCount: 0,
          paidServeCount: 0,
          freeServeCount: 0,
          failedPaymentCount: 0,
          paymentRequiredCount: 0,
          revenueUsdc: '0',
          lastAccessAt: null,
          lastPaidAt: null,
        },
      },
      recentAccesses: [],
      artifacts: [],
    });

    renderTab();

    expect((await screen.findByTestId('execution-data-permission')).textContent).toMatch(
      /Permission required to view execution data/i,
    );
    expect(screen.getByText('No execution data yet.')).toBeTruthy();
  });

  it('renders projection and anchor sections with an explorer link when both are present', async () => {
    listPendingMock.mockResolvedValue({ captures: [] });
    listArtifactsMock.mockImplementation((opts: { source?: string }) => Promise.resolve({
      schemaVersion: 2,
      generatedAt: '2026-05-25T15:00:00.000Z',
      source: opts.source ?? 'served',
      pricing: { publicEndpoint: '', defaultPriceUsdc: '0', perArtifactTypePrice: {}, donation: { enabled: false } },
      summary: {
        served: { totalCount: opts.source === 'served' ? 1 : 0, totalBytes: 100, freeCount: 1, gatedCount: 0, latestCreatedAt: null, artifactTypes: [] },
        network: { totalCount: 0, totalBytes: 0, latestFetchedAt: null, artifactTypes: [] },
        access: { accessCount: 0, paidServeCount: 0, freeServeCount: 0, failedPaymentCount: 0, paymentRequiredCount: 0, revenueUsdc: '0', lastAccessAt: null, lastPaidAt: null },
      },
      recentAccesses: [],
      artifacts: opts.source === 'served'
        ? [{
            source: 'served',
            sha256: 'd'.repeat(64),
            artifactType: 'swe-rebench-v2_v1_solution',
            requestId: 'req-projection',
            envelopeCid: 'bafy-with-projection',
            contentSize: 100,
            priceUsdc: '0',
            createdAt: '2026-05-25T15:00:00.000Z',
            endpoint: null,
            access: {
              accessCount: 0, paidServeCount: 0, freeServeCount: 0, failedPaymentCount: 0,
              paymentRequiredCount: 0, revenueUsdc: '0', lastAccessAt: null, lastPaidAt: null,
            },
            projection: {
              envelopeId: 'env-d',
              signatureHash: '0xsigd',
              solverType: 'swe-rebench-v2',
              role: 'solution',
              taskCid: 'bafy-task',
              taskId: 'task-1',
              requestId: 'req-projection',
              generatedAt: 1748178573,
              evidenceTier: 'self-signed',
              participantSafeAddress: '0xsafe',
              participantAgentEoa: '0xeoa',
              executor: {
                implName: 'swe-rebench-v2-baseline',
                implVersion: '0.1.0',
                runtimeBundleDigest: 'sha256:beef',
                plugins: ['shell'],
              },
              metadata: null,
            },
            anchors: [{
              contentKind: 'envelope',
              metadataKey: 'envelope:bafy-with-projection',
              agentId: '42',
              chainId: 84532,
              identityRegistryAddress: '0xreg',
              txHash: '0xanchortx',
              blockNumber: 12345,
              payloadHex: '0xabcdef',
              anchoredAt: 1748178533,
            }],
          }]
        : [],
    }));

    renderTab();

    const row = await screen.findByText('swe-rebench-v2_v1_solution');
    fireEvent.click(row);

    expect(await screen.findByText('Envelope')).toBeTruthy();
    expect(screen.getByText('Participant')).toBeTruthy();
    expect(screen.getByText('Task')).toBeTruthy();
    expect(screen.getByText('On-chain anchors')).toBeTruthy();
    // solverType in Envelope section
    expect(screen.getByText('swe-rebench-v2')).toBeTruthy();
    // executor impl in Participant section
    expect(screen.getByText('swe-rebench-v2-baseline')).toBeTruthy();
    // anchor agent ID + chain
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('84532')).toBeTruthy();
    // Explorer link for Base Sepolia (chainId 84532)
    const link = screen.getByRole('link', { name: /0xanchortx/i });
    expect(link.getAttribute('href')).toBe('https://sepolia.basescan.org/tx/0xanchortx');
  });

  it('shows "no on-chain anchor" placeholder when anchors is empty', async () => {
    listPendingMock.mockResolvedValue({ captures: [] });
    listArtifactsMock.mockImplementation((opts: { source?: string }) => Promise.resolve({
      schemaVersion: 2,
      generatedAt: '2026-05-25T15:00:00.000Z',
      source: opts.source ?? 'served',
      pricing: { publicEndpoint: '', defaultPriceUsdc: '0', perArtifactTypePrice: {}, donation: { enabled: false } },
      summary: {
        served: { totalCount: opts.source === 'served' ? 1 : 0, totalBytes: 10, freeCount: 1, gatedCount: 0, latestCreatedAt: null, artifactTypes: [] },
        network: { totalCount: 0, totalBytes: 0, latestFetchedAt: null, artifactTypes: [] },
        access: { accessCount: 0, paidServeCount: 0, freeServeCount: 0, failedPaymentCount: 0, paymentRequiredCount: 0, revenueUsdc: '0', lastAccessAt: null, lastPaidAt: null },
      },
      recentAccesses: [],
      artifacts: opts.source === 'served'
        ? [{
            source: 'served',
            sha256: 'e'.repeat(64),
            artifactType: 'plain_artifact',
            requestId: null,
            envelopeCid: null,
            contentSize: 10,
            priceUsdc: '0',
            createdAt: '2026-05-25T15:00:00.000Z',
            endpoint: null,
            access: { accessCount: 0, paidServeCount: 0, freeServeCount: 0, failedPaymentCount: 0, paymentRequiredCount: 0, revenueUsdc: '0', lastAccessAt: null, lastPaidAt: null },
            anchors: [],
          }]
        : [],
    }));

    renderTab();
    const row = await screen.findByText('plain_artifact');
    fireEvent.click(row);
    expect(await screen.findByText(/no on-chain anchor/i)).toBeTruthy();
  });
});
