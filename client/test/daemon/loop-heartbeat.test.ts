/**
 * #1043 — loop heartbeat helper. A namespaced `loop_heartbeat:<name>` config
 * row records the wall-clock ms of each loop's last completed iteration. The
 * watchdog reads these rows to detect a frozen loop. The helper is added
 * ALONGSIDE (never replacing) the legacy `last_*_tick_at` writes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Store } from '../../src/store/store.js';
import {
  LOOP_HEARTBEAT_PREFIX,
  LOOP_NAMES,
  getLoopTick,
  loopHeartbeatKey,
  recordLoopTick,
} from '../../src/daemon/loop-heartbeat.js';

describe('#1043 loop-heartbeat helper', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('namespaces the config key under the loop_heartbeat: prefix', () => {
    expect(loopHeartbeatKey('creator')).toBe(`${LOOP_HEARTBEAT_PREFIX}creator`);
  });

  it('round-trips a recorded tick as the wall-clock ms it wrote', () => {
    const before = Date.now();
    recordLoopTick(store, 'engine-tick');
    const after = Date.now();

    const tick = getLoopTick(store, 'engine-tick');
    expect(tick).not.toBeNull();
    expect(tick).toBeGreaterThanOrEqual(before);
    expect(tick).toBeLessThanOrEqual(after);
  });

  it('returns null for a loop that has never ticked', () => {
    expect(getLoopTick(store, 'peer-sync')).toBeNull();
  });

  it('returns null when the stored value is not a finite number', () => {
    store.setConfigValue(loopHeartbeatKey('creator'), 'not-a-number');
    expect(getLoopTick(store, 'creator')).toBeNull();
  });

  it('enumerates the eight canonical watchdog loops', () => {
    expect([...LOOP_NAMES].sort()).toEqual(
      [
        'balance-topup',
        'creator',
        'delivery-watcher',
        'engine-tick',
        'engine-watcher',
        'harvest',
        'peer-sync',
        'reward-claim',
      ].sort(),
    );
  });
});
