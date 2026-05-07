import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { GeneratorPanel, buildPatch } from './GeneratorPanel.js';
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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('GeneratorPanel', () => {
  it('pre-fills inputs from record.generatorConfig', () => {
    render(<GeneratorPanel record={buildRecord()} onSave={async () => undefined} />);
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
    const save = screen.getByTestId('launcher-launched-generator-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('Save invokes onSave with the diff patch only', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<GeneratorPanel record={buildRecord()} onSave={onSave} />);
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
