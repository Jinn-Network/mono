/**
 * The shared poison ledger (#2473, umbrella #2461).
 *
 * Three properties matter, and each is a defect this module exists to close:
 * a first failure must NOT quarantine (that would drop signed history on one transient
 * fault — the lossiness #2529 refused); the Nth consecutive failure MUST quarantine, so a
 * permanently poisoned item stops wedging its tick; and a success in between must reset the
 * count, so unrelated transients cannot accumulate into a spurious quarantine.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { Store } from '../../src/store/store.js';
import { getEventBuffer } from '../../src/events/emitter.js';
import {
  NATIVE_DISCOVERY_POISON_QUARANTINE_THRESHOLD,
  NATIVE_DISCOVERY_POISON_QUARANTINE_EVENT,
  clearPoisonFailures,
  isPoisonQuarantined,
  recordPoisonFailure,
} from '../../src/daemon/native-discovery-quarantine.js';

const SOURCE = { agent: 'did:key:zRequester', name: 'requester' };
const ENTRY_DIGEST = `sha256:${'e'.repeat(64)}` as const;

let store: Store;

beforeEach(() => {
  store = new Store(':memory:');
});

function failure(overrides: Partial<Parameters<typeof recordPoisonFailure>[0]> = {}) {
  return recordPoisonFailure({
    store,
    scope: 'announcement',
    source: SOURCE,
    sequence: '0000000000000001',
    entryDigest: ENTRY_DIGEST,
    announcementId: 'announcement-1',
    detail: 'chainId is not a canonical unsigned integer',
    ...overrides,
  });
}

describe('native discovery poison quarantine', () => {
  it('does not quarantine before the threshold — a transient fault must not drop signed history', () => {
    for (let attempt = 1; attempt < NATIVE_DISCOVERY_POISON_QUARANTINE_THRESHOLD; attempt += 1) {
      expect(failure()).toEqual({ failures: attempt, quarantined: false });
      expect(isPoisonQuarantined({
        store, scope: 'announcement', source: SOURCE, entryDigest: ENTRY_DIGEST, announcementId: 'announcement-1',
      })).toBe(false);
    }
  });

  it('quarantines at the threshold and stays quarantined for every later failure', () => {
    let result = failure();
    for (let attempt = 2; attempt <= NATIVE_DISCOVERY_POISON_QUARANTINE_THRESHOLD; attempt += 1) {
      result = failure();
    }
    expect(result.quarantined).toBe(true);
    expect(result).toEqual({
      failures: NATIVE_DISCOVERY_POISON_QUARANTINE_THRESHOLD,
      quarantined: true,
    });
    expect(isPoisonQuarantined({
      store, scope: 'announcement', source: SOURCE, entryDigest: ENTRY_DIGEST, announcementId: 'announcement-1',
    })).toBe(true);
    expect(failure().quarantined).toBe(true);
  });

  it('emits the named structured event exactly once, at the transition', () => {
    getEventBuffer().clear();
    for (let attempt = 1; attempt <= NATIVE_DISCOVERY_POISON_QUARANTINE_THRESHOLD + 2; attempt += 1) {
      failure();
    }
    const emitted = getEventBuffer().snapshot()
      .filter((event) => event.errorCode === NATIVE_DISCOVERY_POISON_QUARANTINE_EVENT);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.details).toMatchObject({
      scope: 'announcement',
      sourceAgent: SOURCE.agent,
      sourceName: SOURCE.name,
      announcementId: 'announcement-1',
      entryDigest: ENTRY_DIGEST,
      failures: NATIVE_DISCOVERY_POISON_QUARANTINE_THRESHOLD,
    });
  });

  it('resets the count on success, so unrelated transients never accumulate', () => {
    failure();
    failure();
    clearPoisonFailures({
      store, scope: 'announcement', source: SOURCE, entryDigest: ENTRY_DIGEST, announcementId: 'announcement-1',
    });
    expect(failure()).toEqual({ failures: 1, quarantined: false });
  });

  it('keeps a quarantined item quarantined across a clear — a clear only drops the counter', () => {
    for (let attempt = 1; attempt <= NATIVE_DISCOVERY_POISON_QUARANTINE_THRESHOLD; attempt += 1) {
      failure();
    }
    clearPoisonFailures({
      store, scope: 'announcement', source: SOURCE, entryDigest: ENTRY_DIGEST, announcementId: 'announcement-1',
    });
    expect(isPoisonQuarantined({
      store, scope: 'announcement', source: SOURCE, entryDigest: ENTRY_DIGEST, announcementId: 'announcement-1',
    })).toBe(true);
  });

  it('keys scope, source and announcement independently', () => {
    for (let attempt = 1; attempt <= NATIVE_DISCOVERY_POISON_QUARANTINE_THRESHOLD; attempt += 1) {
      failure();
    }
    expect(isPoisonQuarantined({
      store, scope: 'withdrawal', source: SOURCE, entryDigest: ENTRY_DIGEST, announcementId: 'announcement-1',
    })).toBe(false);
    expect(isPoisonQuarantined({
      store, scope: 'announcement', source: SOURCE, entryDigest: ENTRY_DIGEST, announcementId: 'announcement-2',
    })).toBe(false);
    expect(isPoisonQuarantined({
      store,
      scope: 'announcement',
      source: { agent: 'did:key:zOther', name: 'requester' },
      entryDigest: ENTRY_DIGEST,
      announcementId: 'announcement-1',
    })).toBe(false);
    // The entry digest is part of the key: a corrected re-announcement of the same id, in a
    // NEW signed entry, is not covered by the old entry's quarantine.
    expect(isPoisonQuarantined({
      store,
      scope: 'announcement',
      source: SOURCE,
      entryDigest: `sha256:${'d'.repeat(64)}`,
      announcementId: 'announcement-1',
    })).toBe(false);
  });
});
