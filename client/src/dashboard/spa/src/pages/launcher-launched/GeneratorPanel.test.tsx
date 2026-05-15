import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  GeneratorPanel,
  buildPatch,
  buildSweRebenchV2Patch,
} from './GeneratorPanel.js';
import type { LaunchedSolverNetRecord } from '../../api/types.js';

function buildRecord(
  overrides: Partial<LaunchedSolverNetRecord> = {},
): LaunchedSolverNetRecord {
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: 'sn-1',
    manifestCid: 'bafybeig',
    manifestHash: '0xabc',
    launcherAgentId: '5474',
    launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    launchedAt: '2026-05-05T15:00:00Z',
    status: 'launched',
    statusUpdatedAt: '2026-05-05T15:00:00Z',
    generatorEnabled: true,
    generatorConfig: {
      cadenceMs: 21600000,
      submissionWindowMs: 21600000,
      resolveGapMs: 3600000,
      maxNewRoundsPerPoll: 25,
      maxNewRoundsPerDay: 100,
      maxOpenRounds: 250,
      allowlistConditionIds: ['0xabc'],
      blocklistConditionIds: [],
    },
    registry: {},
    ...overrides,
  };
}

function buildSweRebenchRecord(
  overrides: Partial<LaunchedSolverNetRecord> = {},
): LaunchedSolverNetRecord {
  return buildRecord({
    generatorConfig: {
      N_target_successes: 1,
      N_max_postings_per_task: 1,
      cooldown_ms: 86_400_000,
      claimPolicy: {
        maxClaims: 50,
        maxClaimsPerOperator: 5,
        claimLeaseTtlSeconds: 3_600,
      },
    },
    summary: {
      manifestCid: 'bafybeig',
      solverNetId: 'sn-1',
      name: 'SWE-rebench v2',
      network: 'base-sepolia',
      launcherAgentId: '5474',
      launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
      status: 'launched',
      statusUpdatedAt: '2026-05-05T15:00:00Z',
      contractId: 'swe-rebench-v2',
      contractVersion: 'v1',
      solutionPriceWei: '10000000000',
      verdictPriceWei: '5000000000',
      openRoles: ['solver', 'evaluator'],
      anchorBlock: 1,
    },
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

function expandGeneratorConfig(): void {
  fireEvent.click(screen.getByTestId('launcher-launched-generator-toggle'));
}

describe('GeneratorPanel', () => {
  it('keeps generator config collapsed by default', () => {
    render(<GeneratorPanel record={buildRecord()} onSave={async () => undefined} />);

    const toggle = screen.getByTestId('launcher-launched-generator-toggle');
    expect(toggle.textContent).toBe('Edit config');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('launcher-launched-generator-config')).toBeNull();
    expect(screen.queryByTestId('launcher-launched-generator-cadenceMs')).toBeNull();
    expect(screen.getByTestId('launcher-launched-generator-enabled').textContent).toBe('yes');
  });

  it('keeps swe-rebench-v2 generator config collapsed by default', () => {
    render(<GeneratorPanel record={buildSweRebenchRecord()} onSave={async () => undefined} />);

    const toggle = screen.getByTestId('launcher-launched-generator-toggle');
    expect(toggle.textContent).toBe('Edit config');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('launcher-launched-generator-config')).toBeNull();
    expect(screen.queryByTestId('launcher-launched-generator-N_target_successes')).toBeNull();
    expect(screen.getByTestId('launcher-launched-generator-enabled').textContent).toBe('yes');
  });

  it('expands generator config from the launcher page panel', () => {
    render(<GeneratorPanel record={buildRecord()} onSave={async () => undefined} />);

    expandGeneratorConfig();

    const toggle = screen.getByTestId('launcher-launched-generator-toggle');
    expect(toggle.textContent).toBe('Hide config');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('launcher-launched-generator-config')).toBeTruthy();
    expect(screen.getByTestId('launcher-launched-generator-cadenceMs')).toBeTruthy();
  });

  it('pre-fills inputs from record.generatorConfig', () => {
    render(<GeneratorPanel record={buildRecord()} onSave={async () => undefined} />);
    expandGeneratorConfig();
    expect(
      (screen.getByTestId('launcher-launched-generator-cadenceMs') as HTMLInputElement).value,
    ).toBe('21600000');
    expect(
      (screen.getByTestId('launcher-launched-generator-windowMs') as HTMLInputElement).value,
    ).toBe('21600000');
    expect(
      (screen.getByTestId('launcher-launched-generator-maxOpenRounds') as HTMLInputElement).value,
    ).toBe('250');
    expect(
      (screen.getByTestId(
        'launcher-launched-generator-allowlistConditionIds',
      ) as HTMLTextAreaElement).value,
    ).toBe('0xabc');
  });

  it('Save is disabled until the form is dirty', () => {
    render(<GeneratorPanel record={buildRecord()} onSave={async () => undefined} />);
    expandGeneratorConfig();
    const save = screen.getByTestId('launcher-launched-generator-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('Save invokes onSave with the diff patch only', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<GeneratorPanel record={buildRecord()} onSave={onSave} />);
    expandGeneratorConfig();
    fireEvent.change(screen.getByTestId('launcher-launched-generator-maxOpenRounds'), {
      target: { value: '500' },
    });
    fireEvent.click(screen.getByTestId('launcher-launched-generator-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ maxOpenRounds: 500 });
    await waitFor(() => {
      expect(
        screen.getByTestId('launcher-launched-generator-save-status').textContent,
      ).toMatch(/Saved at/);
    });
  });

  it('rejects sub-60s cadence via inline error and disables Save', () => {
    const onSave = vi.fn();
    render(<GeneratorPanel record={buildRecord()} onSave={onSave} />);
    expandGeneratorConfig();
    fireEvent.change(screen.getByTestId('launcher-launched-generator-cadenceMs'), {
      target: { value: '5000' },
    });
    expect(
      screen.getByTestId('launcher-launched-generator-cadenceMs-error').textContent,
    ).toMatch(/at least 60s/);
    const save = screen.getByTestId('launcher-launched-generator-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('rejects non-numeric input', () => {
    render(<GeneratorPanel record={buildRecord()} onSave={async () => undefined} />);
    expandGeneratorConfig();
    fireEvent.change(screen.getByTestId('launcher-launched-generator-maxOpenRounds'), {
      target: { value: 'abc' },
    });
    expect(
      screen.getByTestId('launcher-launched-generator-maxOpenRounds-error').textContent,
    ).toMatch(/positive integer/);
  });

  it('windowMs maps to submissionWindowMs in the patch', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<GeneratorPanel record={buildRecord()} onSave={onSave} />);
    expandGeneratorConfig();
    fireEvent.change(screen.getByTestId('launcher-launched-generator-windowMs'), {
      target: { value: '7200000' },
    });
    fireEvent.click(screen.getByTestId('launcher-launched-generator-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ submissionWindowMs: 7200000 });
  });

  it('list field changes are sent as parsed arrays', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<GeneratorPanel record={buildRecord()} onSave={onSave} />);
    expandGeneratorConfig();
    fireEvent.change(
      screen.getByTestId('launcher-launched-generator-allowlistConditionIds'),
      { target: { value: '0xabc, 0xdef' } },
    );
    fireEvent.click(screen.getByTestId('launcher-launched-generator-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({ allowlistConditionIds: ['0xabc', '0xdef'] });
  });

  it('surfaces last-error block when generatorState.lastError is set', () => {
    render(
      <GeneratorPanel
        record={buildRecord({
          generatorState: {
            lastPollAt: '2026-05-05T15:00:00Z',
            lastError: { message: 'rate-limited', at: '2026-05-05T15:01:00Z' },
          },
        })}
        onSave={async () => undefined}
      />,
    );
    const errBox = screen.getByTestId('launcher-launched-generator-error');
    expect(errBox.textContent).toContain('rate-limited');
  });

  it('renders the generator-state badge as Errored when lastError is set', () => {
    render(
      <GeneratorPanel
        record={buildRecord({
          generatorState: {
            lastError: { message: 'oops', at: '2026-05-05T15:01:00Z' },
          },
        })}
        onSave={async () => undefined}
      />,
    );
    expect(
      screen.getByTestId('launcher-launched-generator-state-badge').textContent,
    ).toBe('Errored');
  });

  it('renders the generator-state badge as Disabled when generatorEnabled is false', () => {
    render(
      <GeneratorPanel
        record={buildRecord({ generatorEnabled: false })}
        onSave={async () => undefined}
      />,
    );
    expect(
      screen.getByTestId('launcher-launched-generator-state-badge').textContent,
    ).toBe('Disabled');
  });

  it('surfaces save error message inline when onSave throws', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('500 boom'));
    render(<GeneratorPanel record={buildRecord()} onSave={onSave} />);
    expandGeneratorConfig();
    fireEvent.change(screen.getByTestId('launcher-launched-generator-maxOpenRounds'), {
      target: { value: '500' },
    });
    fireEvent.click(screen.getByTestId('launcher-launched-generator-save'));
    await waitFor(() => {
      expect(
        screen.getByTestId('launcher-launched-generator-save-status').textContent,
      ).toMatch(/Save failed: 500 boom/);
    });
  });

  it('renders swe-rebench-v2 generator fields for swe launched records', () => {
    render(<GeneratorPanel record={buildSweRebenchRecord()} onSave={async () => undefined} />);
    expandGeneratorConfig();
    expect(
      (screen.getByTestId('launcher-launched-generator-N_target_successes') as HTMLInputElement).value,
    ).toBe('1');
    expect(
      (screen.getByTestId(
        'launcher-launched-generator-N_max_postings_per_task',
      ) as HTMLInputElement).value,
    ).toBe('1');
    expect(
      (screen.getByTestId('launcher-launched-generator-cooldown_ms') as HTMLInputElement).value,
    ).toBe('86400000');
    expect(
      (screen.getByTestId(
        'launcher-launched-generator-claimPolicy-maxClaims',
      ) as HTMLInputElement).value,
    ).toBe('50');
    expect(
      (screen.getByTestId(
        'launcher-launched-generator-claimPolicy-maxClaimsPerOperator',
      ) as HTMLInputElement).value,
    ).toBe('5');
    expect(
      (screen.getByTestId(
        'launcher-launched-generator-claimPolicy-claimLeaseTtlSeconds',
      ) as HTMLInputElement).value,
    ).toBe('3600');
    expect(screen.queryByTestId('launcher-launched-generator-cadenceMs')).toBeNull();
  });

  it('saves swe-rebench-v2 generator patch keys', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<GeneratorPanel record={buildSweRebenchRecord()} onSave={onSave} />);
    expandGeneratorConfig();
    fireEvent.change(screen.getByTestId('launcher-launched-generator-N_target_successes'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByTestId('launcher-launched-generator-N_max_postings_per_task'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByTestId('launcher-launched-generator-cooldown_ms'), {
      target: { value: '300000' },
    });
    fireEvent.change(screen.getByTestId('launcher-launched-generator-claimPolicy-maxClaims'), {
      target: { value: '10' },
    });
    fireEvent.change(
      screen.getByTestId('launcher-launched-generator-claimPolicy-maxClaimsPerOperator'),
      {
        target: { value: '2' },
      },
    );
    fireEvent.change(
      screen.getByTestId('launcher-launched-generator-claimPolicy-claimLeaseTtlSeconds'),
      {
        target: { value: '1800' },
      },
    );
    fireEvent.click(screen.getByTestId('launcher-launched-generator-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      N_target_successes: 3,
      N_max_postings_per_task: 10,
      cooldown_ms: 300000,
      claimPolicy: {
        maxClaims: 10,
        maxClaimsPerOperator: 2,
        claimLeaseTtlSeconds: 1800,
      },
    });
  });
});

describe('buildPatch', () => {
  const prior = {
    cadenceMs: '21600000',
    windowMs: '21600000',
    resolveGapMs: '3600000',
    maxNewRoundsPerPoll: '25',
    maxNewRoundsPerDay: '100',
    maxOpenRounds: '250',
    allowlistConditionIds: '0xabc',
    blocklistConditionIds: '',
  };

  it('returns an empty patch when nothing changed', () => {
    const r = buildPatch({ ...prior }, prior);
    expect(r.ok).toBe(true);
    expect(r.patch).toEqual({});
  });

  it('returns only the changed numeric field', () => {
    const r = buildPatch({ ...prior, maxOpenRounds: '500' }, prior);
    expect(r.ok).toBe(true);
    expect(r.patch).toEqual({ maxOpenRounds: 500 });
  });

  it('reports cadence error when sub-60s', () => {
    const r = buildPatch({ ...prior, cadenceMs: '5000' }, prior);
    expect(r.ok).toBe(false);
    expect(r.errors.cadenceMs).toMatch(/at least 60s/);
  });

  it('reports positive-integer error for negative numeric input', () => {
    const r = buildPatch({ ...prior, maxOpenRounds: '-1' }, prior);
    expect(r.ok).toBe(false);
    expect(r.errors.maxOpenRounds).toMatch(/positive integer/);
  });
});

describe('buildSweRebenchV2Patch', () => {
  const prior = {
    N_target_successes: '1',
    N_max_postings_per_task: '1',
    cooldown_ms: '86400000',
    maxClaims: '50',
    maxClaimsPerOperator: '5',
    claimLeaseTtlSeconds: '3600',
  };

  it('returns only changed swe-rebench fields', () => {
    const r = buildSweRebenchV2Patch({
      ...prior,
      N_target_successes: '3',
      N_max_postings_per_task: '10',
    }, prior);
    expect(r.ok).toBe(true);
    expect(r.patch).toEqual({
      N_target_successes: 3,
      N_max_postings_per_task: 10,
    });
  });

  it('requires max postings to cover target successes', () => {
    const r = buildSweRebenchV2Patch({
      ...prior,
      N_target_successes: '3',
      N_max_postings_per_task: '2',
    }, prior);
    expect(r.ok).toBe(false);
    expect(r.errors.N_max_postings_per_task).toMatch(/target successes/);
  });

  it('rejects sub-60s cooldown', () => {
    const r = buildSweRebenchV2Patch({ ...prior, cooldown_ms: '5000' }, prior);
    expect(r.ok).toBe(false);
    expect(r.errors.cooldown_ms).toMatch(/at least 60s/);
  });

  it('returns nested claim policy edits', () => {
    const r = buildSweRebenchV2Patch({
      ...prior,
      maxClaims: '10',
      maxClaimsPerOperator: '2',
      claimLeaseTtlSeconds: '1800',
    }, prior);
    expect(r.ok).toBe(true);
    expect(r.patch).toEqual({
      claimPolicy: {
        maxClaims: 10,
        maxClaimsPerOperator: 2,
        claimLeaseTtlSeconds: 1800,
      },
    });
  });

  it('requires claims per operator to fit under max claims', () => {
    const r = buildSweRebenchV2Patch({
      ...prior,
      maxClaims: '3',
      maxClaimsPerOperator: '5',
    }, prior);
    expect(r.ok).toBe(false);
    expect(r.errors.maxClaimsPerOperator).toMatch(/max claims/);
  });
});
