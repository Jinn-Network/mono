import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const approveMock = vi.fn();
const skipMock = vi.fn();
const trustRepoMock = vi.fn();

vi.mock('../api/client.js', () => ({
  api: {
    captures: {
      listPending: async () => ({
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
      }),
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
  it('renders pending captures and exposes approve/skip/trust actions', async () => {
    approveMock.mockResolvedValue({ ok: true, sessionId: 'sess-1', envelopeCid: 'bafy', publishedAt: 'now' });
    skipMock.mockResolvedValue({ ok: true, sessionId: 'sess-1', skippedAt: 'now' });
    trustRepoMock.mockResolvedValue({ ok: true, repoRemoteUrl: 'git@example.com:repo.git', trusted: true });

    renderTab();

    expect(await screen.findByText('sess-1')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('user-message').length).toBeGreaterThan(0));
    expect(screen.getByText('http.request.header.authorization')).toBeTruthy();

    fireEvent.click(screen.getByText('Trust repo'));
    await waitFor(() => expect(trustRepoMock).toHaveBeenCalledWith('git@example.com:repo.git', true));

    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith('sess-1'));
  });
});
