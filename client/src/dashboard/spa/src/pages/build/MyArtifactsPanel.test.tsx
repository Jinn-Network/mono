import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MyArtifactsPanel } from './MyArtifactsPanel.js';

import type { JSX } from 'react';

function withQuery(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe('MyArtifactsPanel (hfmf)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows a "complete identity bootstrap" prompt when fleet_agent_id is undefined', () => {
    render(withQuery(<MyArtifactsPanel fleetAgentId={undefined} />));
    expect(screen.getByText(/complete identity bootstrap/i)).toBeTruthy();
  });

  it('lists artifacts when fleet_agent_id is set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        artifacts: [
          {
            builderAgentId: '42',
            cid: 'bafyx',
            name: '@me/x',
            version: '0.1.0',
            supports: ['swe-rebench-v2.v1'],
            publishedAt: 1715600000,
            artifactType: 'plugin',
            revoked: false,
          },
        ],
      }),
    }));
    render(withQuery(<MyArtifactsPanel fleetAgentId="42" />));
    await waitFor(() => {
      expect(screen.getByText('@me/x')).toBeTruthy();
    });
  });

  it('renders empty-state when builder has published no artifacts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ artifacts: [] }),
    }));
    render(withQuery(<MyArtifactsPanel fleetAgentId="42" />));
    await waitFor(() => {
      expect(screen.getByText(/you have not published any plug-ins yet/i)).toBeTruthy();
    });
  });

  it('calls /v1/discovery/builder-artifacts with the agentId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ artifacts: [] }),
    }));
    render(withQuery(<MyArtifactsPanel fleetAgentId="42" />));
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringContaining('builderAgentId=42'),
        expect.any(Object),
      );
    });
  });
});
