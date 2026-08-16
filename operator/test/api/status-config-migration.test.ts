import { describe, expect, it } from 'vitest';
import { assembleStatusV1, type GatheredStatusRaw } from '../../src/api/status-build.js';

// Mirrors the minimal raw-status fixture used by status-build.test.ts —
// `assembleStatusV1` dereferences `raw.master.*` unconditionally, so a bare
// `{ configMigration: {...} }` literal (as the plan's Step 1 draft used)
// throws before the assertions run. This fixture supplies every field
// `assembleStatusV1` reads without optional chaining.
function minimalRaw(overrides: Partial<GatheredStatusRaw> = {}): GatheredStatusRaw {
  return {
    shutdownState: 'running',
    dbPath: '/tmp/x.db',
    activityCounts: {},
    recentActivity: [],
    lastRewardClaimTickAt: null,
    rewardClaimIntervalMs: 0,
    fleet: null,
    rpc: { ok: true },
    master: { address: null },
    pollIntervalMs: 5000,
    masterDailyEstimateWei: '1000',
    ...overrides,
  };
}

describe('status configMigration', () => {
  it('surfaces the migration report with capsUnset when caps are unset', () => {
    const status = assembleStatusV1(
      minimalRaw({
        configMigration: {
          shapeVersion: 2,
          wiringEntries: 1,
          postingEntries: 0,
          backupPath: '/home/op/.jinn-client/config.json.backup-20260730T091500Z',
          capsUnset: true,
        },
      }),
    );
    expect(status.configMigration).toEqual({
      shapeVersion: 2,
      wiringEntries: 1,
      postingEntries: 0,
      backupPath: '/home/op/.jinn-client/config.json.backup-20260730T091500Z',
      capsUnset: true,
    });
  });

  it('omits configMigration when nothing migrated this boot', () => {
    const status = assembleStatusV1(minimalRaw());
    expect(status.configMigration).toBeUndefined();
  });
});
