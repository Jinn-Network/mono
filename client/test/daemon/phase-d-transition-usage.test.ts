import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  configurePhaseDTransitionUsage,
  phaseDTransitionUsageDiagnostics,
  phaseDTransitionUsageSnapshot,
  recordPhaseDTransitionUse,
} from '../../src/compatibility/phase-d-transition-usage.js';

describe('Phase D transition usage diagnostics', () => {
  it('records monotonic counts and preserves the first-observation time', () => {
    const signal = 'legacy-wiring-config-field' as const;
    const before = phaseDTransitionUsageSnapshot().find((row) => row.signal === signal);
    recordPhaseDTransitionUse(signal, new Date('2026-08-03T00:00:00.000Z'));
    recordPhaseDTransitionUse(signal, new Date('2026-08-03T00:00:01.000Z'));
    const row = phaseDTransitionUsageSnapshot().find((value) => value.signal === signal);
    expect(row).toEqual({
      signal,
      count: (before?.count ?? 0) + 2,
      firstObservedAt: before?.firstObservedAt ?? '2026-08-03T00:00:00.000Z',
      lastObservedAt: '2026-08-03T00:00:01.000Z',
    });
  });

  it('records the native-operator-composition signal as positive native-presence evidence (#2380)', () => {
    const signal = 'native-operator-composition' as const;
    const before = phaseDTransitionUsageSnapshot().find((row) => row.signal === signal);
    recordPhaseDTransitionUse(signal, new Date('2026-08-04T00:00:00.000Z'));
    const row = phaseDTransitionUsageSnapshot().find((value) => value.signal === signal);
    expect(row).toEqual({
      signal,
      count: (before?.count ?? 0) + 1,
      firstObservedAt: before?.firstObservedAt ?? '2026-08-04T00:00:00.000Z',
      lastObservedAt: '2026-08-04T00:00:00.000Z',
    });
  });

  it('persists the observation window and counters across a process-style reload', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jinn-phase-d-usage-'));
    const path = join(directory, 'usage.v1.json');
    const otherPath = join(directory, 'other.v1.json');
    try {
      configurePhaseDTransitionUsage(join(directory, 'discard.v1.json'));
      configurePhaseDTransitionUsage(undefined);
      configurePhaseDTransitionUsage(path, new Date('2026-08-03T01:00:00.000Z'));
      recordPhaseDTransitionUse(
        'marketplace-pipeline-invocation',
        new Date('2026-08-03T01:01:00.000Z'),
      );
      configurePhaseDTransitionUsage(otherPath, new Date('2026-08-03T02:00:00.000Z'));
      configurePhaseDTransitionUsage(path, new Date('2026-08-03T03:00:00.000Z'));

      expect(phaseDTransitionUsageDiagnostics()).toEqual({
        schemaVersion: 1,
        durable: true,
        observationWindowStartedAt: '2026-08-03T01:00:00.000Z',
        counters: [{
          signal: 'marketplace-pipeline-invocation',
          count: 1,
          firstObservedAt: '2026-08-03T01:01:00.000Z',
          lastObservedAt: '2026-08-03T01:01:00.000Z',
        }],
      });
    } finally {
      configurePhaseDTransitionUsage(undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes the durable state file with mode 0600 (Class O container profile, #2409)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jinn-phase-d-usage-mode-'));
    const path = join(directory, 'usage.v1.json');
    try {
      configurePhaseDTransitionUsage(path, new Date('2026-08-04T00:00:00.000Z'));
      recordPhaseDTransitionUse('legacy-wiring-config-field', new Date('2026-08-04T00:00:01.000Z'));
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      configurePhaseDTransitionUsage(undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
