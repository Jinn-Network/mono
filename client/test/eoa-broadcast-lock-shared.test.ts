/**
 * Cross-domain broadcast serialization (the #525/#562/#897 funds-correctness failure class).
 *
 * venue-base's Safe broadcaster (domain 1: `packages/marketplace/venue-base/src/broadcast/
 * safe-broadcaster.ts`) and tx-retry's EOA-direct broadcasters (domain 2: e.g.
 * `IdentityPublisher._writeMetadata`, `client/src/erc8004/identity.ts`) previously held UNRELATED
 * locks: venue-base's durable SQLite `BroadcastLock` (keyed on `(chainId, sender)`, cross-process)
 * vs tx-retry's in-memory `Map` (keyed on `sender` only, in-process). Two concurrent sends from
 * the SAME agent EOA through these two DIFFERENT entry points could both read the same `pending`
 * nonce and collide ("nonce too low" / a silently replaced tx).
 *
 * This test proves the fix the composition root wires in: once `setDefaultEoaBroadcastLock`
 * installs an adapter over the SAME venue-base `BroadcastLock` instance domain 1 uses, a
 * venue-base `lock.withSender` call and a tx-retry `withEoaBroadcastLock` call for the SAME
 * sender serialize against each other -- not just against themselves. Without the fix (the
 * default in-memory lock, unrelated to venue-base's SQLite lock), this test fails: domain 2 runs
 * immediately instead of waiting for domain 1 to release.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  createBroadcastLock,
  openVenueState,
  type BroadcastLock,
  type VenueStateDatabase,
} from '@jinn-network/marketplace-venue-base';
import {
  getDefaultEoaBroadcastLock,
  resetDefaultEoaBroadcastLockForTesting,
  setDefaultEoaBroadcastLock,
  withEoaBroadcastLock,
} from '../src/tx-retry.js';

const CHAIN_ID = 84532;
const SENDER = '0x9999999999999999999999999999999999999999' as Address;

describe('withEoaBroadcastLock -- shared cross-domain lock (issue #525/#562/#897)', () => {
  let root: string;
  let state: VenueStateDatabase;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'eoa-shared-lock-'));
    state = openVenueState(join(root, 'venue.sqlite'));
  });

  afterEach(() => {
    // Never leak the test's shared lock into other test files/order (D0a round 1: the shared
    // lock now refuses a conflicting install, so a stale key must not survive this test either).
    resetDefaultEoaBroadcastLockForTesting();
    state.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serializes a venue-base Safe broadcast (domain 1) against an EOA-direct tx-retry send (domain 2)', async () => {
    const venueLock: BroadcastLock = createBroadcastLock(state);
    setDefaultEoaBroadcastLock(
      { withSender: (sender, fn) => venueLock.withSender(CHAIN_ID, sender, fn) },
      'test-domain-1',
    );

    const order: string[] = [];
    let releaseDomain1!: () => void;
    const domain1Gate = new Promise<void>((resolve) => {
      releaseDomain1 = resolve;
    });

    // Domain 1: venue-base's own lock instance, invoked directly -- exactly how
    // `createSafeBroadcaster`'s `execute()` calls `input.lock.withSender(...)`.
    const domain1 = venueLock.withSender(CHAIN_ID, SENDER, async () => {
      order.push('domain1-start');
      await domain1Gate;
      order.push('domain1-end');
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['domain1-start']);

    // Domain 2: tx-retry's EOA-direct helper -- exactly how
    // `IdentityPublisher._writeMetadata` calls `viemSendTransactionWithRetry` ->
    // `withNonceLedger` -> `withEoaBroadcastLock`.
    const domain2 = withEoaBroadcastLock(SENDER, async () => {
      order.push('domain2-start');
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    // The core assertion: without the shared lock, domain2 holds an unrelated
    // in-memory lock and would run immediately here. With the fix wired in, it
    // must wait for domain1 to release the SAME durable lock.
    expect(order).toEqual(['domain1-start']);

    releaseDomain1();
    await Promise.all([domain1, domain2]);
    expect(order).toEqual(['domain1-start', 'domain1-end', 'domain2-start']);
  });

  it('falls back to independent in-process locks when no shared lock is installed (P5: no default-path regression)', async () => {
    // Precondition: nothing installed this test overrode the default (afterEach always restores
    // it), so this exercises the plain default -- the same behavior the existing
    // 'per-EOA broadcast serialization' describe block in tx-retry.test.ts already covers for
    // same-EOA collisions. Here we assert the OTHER half: an unrelated venue-base lock instance
    // (nothing wired via setDefaultEoaBroadcastLock) does NOT block a tx-retry call for the same
    // sender, which is exactly today's (pre-fix) architecture and must keep working when a host
    // (e.g. a one-shot CLI verb with no venue) never installs a shared lock.
    const venueLock: BroadcastLock = createBroadcastLock(state);

    const order: string[] = [];
    let releaseDomain1!: () => void;
    const domain1Gate = new Promise<void>((resolve) => {
      releaseDomain1 = resolve;
    });

    const domain1 = venueLock.withSender(CHAIN_ID, SENDER, async () => {
      order.push('domain1-start');
      await domain1Gate;
      order.push('domain1-end');
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const domain2 = withEoaBroadcastLock(SENDER, async () => {
      order.push('domain2-start');
    });

    await domain2;
    expect(order).toEqual(['domain1-start', 'domain2-start']);
    releaseDomain1();
    await domain1;
  });
});
