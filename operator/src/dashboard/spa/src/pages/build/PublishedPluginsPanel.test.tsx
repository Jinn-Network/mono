import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PublishedPluginsPanel } from './PublishedPluginsPanel.js';

import type { JSX } from 'react';

const fixture = {
  publications: [
    {
      builderAgentId: '42',
      cid: 'bafyplugin1',
      name: '@you/swe-skill',
      version: '0.1.0',
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1715600000,
      artifactType: 'plugin',
      revoked: false,
      pluginSha256: '0xdead',
    },
    {
      builderAgentId: '99',
      cid: 'bafyplugin2',
      name: '@other/swe-skill',
      version: '0.2.0',
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1715700000,
      artifactType: 'plugin',
      revoked: true,
      revokedReason: 'superseded',
      pluginSha256: '0xbeef',
    },
  ],
};

function withQuery(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe('PublishedPluginsPanel (hfmf)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => fixture,
    }));
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders a row per published plug-in', async () => {
    render(withQuery(<PublishedPluginsPanel solverType="swe-rebench-v2.v1" />));
    await waitFor(() => {
      expect(screen.getByText('@you/swe-skill')).toBeTruthy();
      expect(screen.getByText('@other/swe-skill')).toBeTruthy();
    });
  });

  it('flags revoked rows with a badge', async () => {
    render(withQuery(<PublishedPluginsPanel solverType="swe-rebench-v2.v1" />));
    await waitFor(() => {
      expect(screen.getByText(/revoked/i)).toBeTruthy();
    });
  });

  it('queries the discovery endpoint with the solverType', async () => {
    render(withQuery(<PublishedPluginsPanel solverType="swe-rebench-v2.v1" />));
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringContaining('solverType=swe-rebench-v2.v1'),
        expect.any(Object),
      );
    });
  });

  it('renders the empty state when discovery returns no rows', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ publications: [] }),
    } as Response);
    render(withQuery(<PublishedPluginsPanel solverType="swe-rebench-v2.v1" />));
    await waitFor(() => {
      expect(screen.getByText(/no plug-ins published yet/i)).toBeTruthy();
    });
  });

  it('renders an error message when discovery is unavailable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ error: 'discovery_unavailable' }),
    } as Response);
    render(withQuery(<PublishedPluginsPanel solverType="swe-rebench-v2.v1" />));
    await waitFor(() => {
      expect(screen.getByText(/discovery unavailable/i)).toBeTruthy();
    });
  });
});
