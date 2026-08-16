import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StatusHeader } from './StatusHeader.js';
import type {
  LaunchedSolverNetRecord,
  SolverNetManifestV1,
} from '../../../../../api/contract/index.js';

function buildRecord(
  overrides: Partial<LaunchedSolverNetRecord> = {},
): LaunchedSolverNetRecord {
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: 'agent-1_prediction.v1-1_abcdef01',
    manifestCid: 'bafybeigdyrztabcdef0123456789abcdef0123456789abcdef0123456789abc',
    manifestHash: '0xabc',
    launcherAgentId: '5474',
    launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    launchedAt: '2026-05-05T15:00:00Z',
    status: 'launched',
    statusUpdatedAt: '2026-05-05T15:00:00Z',
    generatorEnabled: true,
    registry: {},
    ...overrides,
  };
}

function buildRecordSummary(
  overrides: Partial<NonNullable<LaunchedSolverNetRecord['summary']>> = {},
): NonNullable<LaunchedSolverNetRecord['summary']> {
  return {
    manifestCid: 'bafybeigdyrztabcdef0123456789abcdef0123456789abcdef0123456789abc',
    solverNetId: 'agent-1_prediction.v1-1_abcdef01',
    name: 'SWE-rebench v2',
    network: 'base-sepolia',
    launcherAgentId: '5474',
    launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    status: 'launched',
    statusUpdatedAt: '2026-05-05T15:00:00Z',
    contractId: 'swe-rebench-v2',
    contractVersion: 'v1',
    solutionPriceWei: '100',
    verdictPriceWei: '50',
    openRoles: ['solver', 'evaluator'],
    anchorBlock: 1,
    ...overrides,
  };
}

function buildManifest(
  overrides: Partial<SolverNetManifestV1> = {},
): SolverNetManifestV1 {
  return {
    schemaVersion: 'solvernet.manifest.v1',
    solverNetId: 'agent-1_prediction.v1-1_abcdef01',
    network: 'base-sepolia',
    name: 'Polymarket',
    description: 'Forecast resolved markets',
    launcher: {
      safeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
      agentEoa: '0xeoaeoaeoaeoaeoaeoaeoaeoaeoaeoaeoaeoaeoa1',
      agentId: '5474',
    },
    contract: {
      id: 'prediction',
      version: 'v1',
      schemas: { task: {}, solution: {}, verdict: {} },
      claimPolicyDefaults: {
        mode: 'parallel',
        maxClaims: 1,
        maxClaimsPerOperator: 1,
        claimLeaseTtlSeconds: 600,
      },
      credentialRequirements: { creator: [], solver: [], evaluator: [] },
      evaluationFunction: {
        id: 'eval-fn',
        deterministic: true,
        inputs: [],
        output: 'bool',
        implementation: '',
      },
      aggregationFunction: {
        id: 'agg-fn',
        deterministic: true,
        inputs: [],
        output: 'score',
      },
    },
    solutionPriceWei: '100',
    verdictPriceWei: '50',
    openRoles: ['solver', 'evaluator'],
    createdAt: '2026-05-05T00:00:00Z',
    launchedAt: '2026-05-05T00:00:00Z',
    signature: { alg: 'eip-191', signer: '0xabc', value: '0xdeadbeef' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('StatusHeader', () => {
  it('renders the manifest name and description', () => {
    render(
      <StatusHeader
        record={buildRecord()}
        manifest={buildManifest()}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByTestId('launcher-launched-name').textContent).toBe('Polymarket');
    expect(screen.getByText(/Forecast resolved markets/)).toBeTruthy();
  });

  it('falls back to the launched record summary while the manifest is loading', () => {
    render(
      <StatusHeader
        record={buildRecord({ summary: buildRecordSummary() })}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByTestId('launcher-launched-name').textContent).toBe('SWE-rebench v2');
  });

  it('falls back to the SolverNet id when no manifest or summary is supplied', () => {
    render(
      <StatusHeader
        record={buildRecord()}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByTestId('launcher-launched-name').textContent).toBe('agent-1_prediction.v1-1_abcdef01');
  });

  it('renders Pause + Retire when status=launched', () => {
    render(
      <StatusHeader
        record={buildRecord({ status: 'launched' })}
        manifest={buildManifest()}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByTestId('launcher-launched-action-paused')).toBeTruthy();
    expect(screen.getByTestId('launcher-launched-action-retired')).toBeTruthy();
    expect(screen.queryByTestId('launcher-launched-action-launched')).toBeNull();
    expect(screen.getByTestId('launcher-launched-status-badge').textContent).toBe('Launched');
  });

  it('renders Resume + Retire when status=paused', () => {
    render(
      <StatusHeader
        record={buildRecord({ status: 'paused' })}
        manifest={buildManifest()}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByTestId('launcher-launched-action-launched')).toBeTruthy();
    expect(screen.getByTestId('launcher-launched-action-retired')).toBeTruthy();
    expect(screen.queryByTestId('launcher-launched-action-paused')).toBeNull();
    expect(screen.getByTestId('launcher-launched-status-badge').textContent).toBe('Paused');
  });

  it('renders the terminal pill with no actions when status=retired', () => {
    render(
      <StatusHeader
        record={buildRecord({ status: 'retired' })}
        manifest={buildManifest()}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByTestId('launcher-launched-terminal-pill')).toBeTruthy();
    expect(screen.queryByTestId('launcher-launched-actions')).toBeNull();
    expect(screen.queryByTestId('launcher-launched-action-paused')).toBeNull();
  });

  it('renders the launching pill with no actions when status=launching', () => {
    render(
      <StatusHeader
        record={buildRecord({ status: 'launching' })}
        manifest={buildManifest()}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByTestId('launcher-launched-launching-pill')).toBeTruthy();
    expect(screen.queryByTestId('launcher-launched-actions')).toBeNull();
  });

  it('renders failed badge with no actions', () => {
    render(
      <StatusHeader
        record={buildRecord({ status: 'failed' })}
        manifest={buildManifest()}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByTestId('launcher-launched-status-badge').textContent).toBe('Failed');
    expect(screen.queryByTestId('launcher-launched-actions')).toBeNull();
  });

  it('clicking Pause invokes onAction("paused")', () => {
    const onAction = vi.fn();
    render(
      <StatusHeader
        record={buildRecord({ status: 'launched' })}
        manifest={buildManifest()}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByTestId('launcher-launched-action-paused'));
    expect(onAction).toHaveBeenCalledWith('paused');
  });

  it('clicking Retire invokes onAction("retired")', () => {
    const onAction = vi.fn();
    render(
      <StatusHeader
        record={buildRecord({ status: 'launched' })}
        manifest={buildManifest()}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByTestId('launcher-launched-action-retired'));
    expect(onAction).toHaveBeenCalledWith('retired');
  });

  it('disables actions and shows pending label when pending matches target', () => {
    render(
      <StatusHeader
        record={buildRecord({ status: 'launched' })}
        manifest={buildManifest()}
        onAction={() => undefined}
        pending="paused"
      />,
    );
    const pauseBtn = screen.getByTestId('launcher-launched-action-paused') as HTMLButtonElement;
    const retireBtn = screen.getByTestId('launcher-launched-action-retired') as HTMLButtonElement;
    expect(pauseBtn.disabled).toBe(true);
    expect(retireBtn.disabled).toBe(true);
    expect(pauseBtn.textContent).toMatch(/Pause…/);
  });

  it('renders truncated launcher Safe + agent + manifest cid', () => {
    render(
      <StatusHeader
        record={buildRecord({
          launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
          launcherAgentId: '5474',
          manifestCid: 'bafybeigdyrztabcdef0123456789',
        })}
        manifest={buildManifest()}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByTestId('launcher-launched-safe').textContent).toMatch(/0xE64b…B5CF/);
    expect(screen.getByTestId('launcher-launched-agent').textContent).toBe('5474');
    // Truncated cid: first 8 chars + ellipsis + last 6 chars.
    expect(screen.getByTestId('launcher-launched-manifest-cid').textContent).toMatch(/bafybeig…/);
  });

  // ── operator-count (issue #351) ───────────────────────────────────────────

  it('renders the operator count when supplied', () => {
    render(
      <StatusHeader
        record={buildRecord()}
        manifest={buildManifest()}
        operatorCount={3}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByTestId('launcher-launched-operator-count').textContent).toMatch(/3/);
    // The aliased `operator-count` test-id (the T2.3 selector) carries the
    // same value via a hidden span — mirrors the `manifest-cid` aliasing.
    expect(screen.getByTestId('operator-count').textContent).toBe('3');
  });

  it('renders an operator count of 0 when no operator has participated yet', () => {
    render(
      <StatusHeader
        record={buildRecord()}
        manifest={buildManifest()}
        operatorCount={0}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByTestId('operator-count').textContent).toBe('0');
  });

  it('omits the operator-count field when the count is undefined', () => {
    render(
      <StatusHeader
        record={buildRecord()}
        manifest={buildManifest()}
        onAction={() => undefined}
      />,
    );
    expect(screen.queryByTestId('launcher-launched-operator-count')).toBeNull();
    expect(screen.queryByTestId('operator-count')).toBeNull();
  });
});
