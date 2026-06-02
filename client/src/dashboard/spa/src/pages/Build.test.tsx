import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { JSX } from 'react';

const getBootstrapMock = vi.fn();
vi.mock('../api/client.js', () => ({
  api: {
    getBootstrap: () => getBootstrapMock(),
    discovery: {
      listPluginPublications: vi.fn().mockResolvedValue({ publications: [] }),
      listBuilderArtifacts: vi.fn().mockResolvedValue({ artifacts: [] }),
      getPluginScores: vi.fn().mockResolvedValue({ scores: [] }),
    },
  },
}));

const { BuildPage } = await import('./Build.js');

function withQuery(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  getBootstrapMock.mockReset();
  getBootstrapMock.mockResolvedValue({
    schemaVersion: 1,
    mode: 'running',
    steps: [],
    currentStep: 'complete',
    services: [],
    master_address: '0xabc',
    chain: 'base-sepolia',
    fleet_agent_id: '42',
  });
});
afterEach(() => {
  cleanup();
});

describe('BuildPage (hfmf)', () => {
  it('renders the intro card heading', async () => {
    render(withQuery(<BuildPage />));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: /build a plug-in/i })).toBeTruthy();
    });
  });

  it('renders the shape catalogue', async () => {
    render(withQuery(<BuildPage />));
    await waitFor(() => {
      expect(screen.getByText(/plug-in shape/i)).toBeTruthy();
    });
  });

  it('renders the published-plug-ins panel for swe-rebench-v2.v1 by default', async () => {
    render(withQuery(<BuildPage />));
    await waitFor(() => {
      expect(screen.getByText(/published plug-ins for swe-rebench-v2\.v1/i)).toBeTruthy();
    });
  });

  it('renders the my-artifacts panel', async () => {
    render(withQuery(<BuildPage />));
    // Match the panel's heading specifically; the same phrase appears
    // inside the quickstart markdown <p> rendered by IntroCard, so a
    // bare getByText would race against the disabled-state transition.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /your published plug-ins/i })).toBeTruthy();
    });
  });

  it('renders the artifact-type filter chip', async () => {
    render(withQuery(<BuildPage />));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /plug-ins/i })).toBeTruthy();
    });
  });
});
