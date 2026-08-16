// No test in this SPA tree currently registers `@testing-library/jest-dom`
// matchers (`toHaveTextContent`, `toHaveValue`, `toBeInTheDocument`, ...) —
// `vitest.config.ts`'s `setupFiles` never wires them up, and every existing
// page test avoids them, asserting on raw DOM state instead. Rather than
// widen an out-of-scope global config file, extend `expect` locally via the
// package's own vitest integration (already an installed devDependency).
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClaimPolicyTab } from './ClaimPolicyTab.js';
import { api } from '../../api/client.js';

import type { JSX } from 'react';

vi.mock('../../api/client.js', () => ({
  api: {
    operator: {
      getClaimPolicy: vi.fn(async () => ({
        claimPolicy: { mode: 'match-legacy-manifest-digest', spendCapWei: '0', aiUnitCap: 0 },
        executionWiring: [
          {
            workKind: 'QmSolver',
            harness: 'claude-code',
            model: 'claude-haiku-4-5-20251001',
            plugins: [],
            credentialRef: 'claude-code-default',
            isolationPolicy: 'process',
            legacyManifestDigest: 'QmSolver',
          },
        ],
        restartRequired: false,
      })),
      setClaimPolicy: vi.fn(async () => {}),
      setExecutionWiring: vi.fn(async () => {}),
    },
  },
}));

// No shared `renderWithProviders` test helper exists in this SPA tree (the
// plan assumed one at `../../test-utils.js`) — every sibling page test
// (NetworkTab.test.tsx, HarnessSelectStep.test.tsx, ...) inlines its own
// QueryClientProvider wrapper, so this mirrors that established convention.
function withProviders(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(api.operator.getClaimPolicy).mockResolvedValue({
    claimPolicy: { mode: 'match-legacy-manifest-digest', spendCapWei: '0', aiUnitCap: 0 },
    executionWiring: [
      {
        workKind: 'QmSolver',
        harness: 'claude-code',
        model: 'claude-haiku-4-5-20251001',
        plugins: [],
        credentialRef: 'claude-code-default',
        isolationPolicy: 'process',
        legacyManifestDigest: 'QmSolver',
      },
    ],
    restartRequired: false,
  });
});

describe('ClaimPolicyTab', () => {
  it('shows the predicate mode, the caps, and one row per wiring entry', async () => {
    render(withProviders(<ClaimPolicyTab />));
    expect(await screen.findByTestId('claim-policy-tab')).toBeInTheDocument();
    expect(screen.getByTestId('claim-policy-mode')).toHaveTextContent(
      'match-legacy-manifest-digest',
    );
    expect(screen.getByTestId('claim-policy-spend-cap')).toHaveValue('0');
    expect(screen.getAllByTestId('execution-wiring-row')).toHaveLength(1);
    expect(screen.getByText('QmSolver')).toBeInTheDocument();
  });

  it('renders the claims-nothing notice while a cap is zero', async () => {
    render(withProviders(<ClaimPolicyTab />));
    expect(await screen.findByTestId('claim-policy-caps-unset')).toHaveTextContent(
      'No tasks will be claimed until both caps are above zero.',
    );
  });

  it('saves an edited spend cap and flags the restart requirement', async () => {
    render(withProviders(<ClaimPolicyTab />));
    const input = await screen.findByTestId('claim-policy-spend-cap');
    fireEvent.change(input, { target: { value: '2500000000000000' } });
    fireEvent.click(screen.getByTestId('claim-policy-save'));
    await waitFor(() =>
      expect(api.operator.setClaimPolicy).toHaveBeenCalledWith({
        claimPolicy: {
          mode: 'match-legacy-manifest-digest',
          spendCapWei: '2500000000000000',
          aiUnitCap: 0,
        },
      }),
    );
    expect(screen.getByTestId('claim-policy-restart-required')).toBeInTheDocument();
  });

  it('renders an empty state naming what fills it', async () => {
    vi.mocked(api.operator.getClaimPolicy).mockResolvedValueOnce({
      claimPolicy: undefined,
      executionWiring: [],
      restartRequired: false,
    });
    render(withProviders(<ClaimPolicyTab />));
    expect(await screen.findByTestId('claim-policy-empty')).toHaveTextContent(
      'Join a SolverNet to create your first execution wiring entry.',
    );
  });
});
