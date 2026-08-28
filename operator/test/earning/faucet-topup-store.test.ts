import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readFaucetTopupState,
  writeFaucetTopupRecord,
  computeTopupQuota,
} from '../../src/earning/faucet-topup-store.js';

const ADDR = '0xAbCdEf0000000000000000000000000000000001';

describe('faucet-topup-store', () => {
  it('returns an empty default when the sidecar is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-topup-missing-'));
    const state = readFaucetTopupState(dir);
    expect(state).toEqual({ schemaVersion: 1, byAddress: {} });
  });

  it('returns an empty default when the sidecar is unreadable garbage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-topup-garbage-'));
    // Write garbage then confirm fail-soft.
    writeFaucetTopupRecord(dir, ADDR, { callsToday: 1, batchStartedAt: 1000 });
    const path = join(dir, 'faucet-topup.json');
    // Corrupt it.
    writeFileSync(path, '{not json');
    const state = readFaucetTopupState(dir);
    expect(state).toEqual({ schemaVersion: 1, byAddress: {} });
  });

  it('round-trips a record keyed by lowercased address with 0o600 mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-topup-rw-'));
    writeFaucetTopupRecord(dir, ADDR, { callsToday: 3, batchStartedAt: 42_000 });
    const state = readFaucetTopupState(dir);
    expect(state.byAddress[ADDR.toLowerCase()]).toEqual({
      callsToday: 3,
      batchStartedAt: 42_000,
    });
    const path = join(dir, 'faucet-topup.json');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('preserves other addresses on read-modify-write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-topup-multi-'));
    const other = '0x1111111111111111111111111111111111111111';
    writeFaucetTopupRecord(dir, other, { callsToday: 1, batchStartedAt: 100 });
    writeFaucetTopupRecord(dir, ADDR, { callsToday: 2, batchStartedAt: 200 });
    const state = readFaucetTopupState(dir);
    expect(state.byAddress[other.toLowerCase()]).toEqual({ callsToday: 1, batchStartedAt: 100 });
    expect(state.byAddress[ADDR.toLowerCase()]).toEqual({ callsToday: 2, batchStartedAt: 200 });
  });

  describe('computeTopupQuota', () => {
    const dailyCap = 10;
    const cooldownMs = 24 * 60 * 60 * 1000;

    it('no record → full quota, no cooldown, window inactive', () => {
      const q = computeTopupQuota({ record: undefined, dailyCap, cooldownMs, now: 5000 });
      expect(q).toEqual({ callsRemaining: 10, cooldownExpiresAt: null, windowActive: false, rateLimited: false });
    });

    it('window elapsed → quota resets, window inactive', () => {
      const batchStartedAt = 1000;
      const now = batchStartedAt + cooldownMs; // exactly at expiry
      const q = computeTopupQuota({
        record: { callsToday: 10, batchStartedAt },
        dailyCap,
        cooldownMs,
        now,
      });
      expect(q.callsRemaining).toBe(10);
      expect(q.windowActive).toBe(false);
      expect(q.cooldownExpiresAt).toBe(batchStartedAt + cooldownMs);
      expect(q.rateLimited).toBe(false);
    });

    it('within window, partial usage → remaining = cap - callsToday, window active', () => {
      const batchStartedAt = 1000;
      const now = batchStartedAt + 1000;
      const q = computeTopupQuota({
        record: { callsToday: 4, batchStartedAt },
        dailyCap,
        cooldownMs,
        now,
      });
      expect(q.callsRemaining).toBe(6);
      expect(q.windowActive).toBe(true);
      expect(q.cooldownExpiresAt).toBe(batchStartedAt + cooldownMs);
      expect(q.rateLimited).toBe(false);
    });

    it('within window, cap reached → remaining 0, window active', () => {
      const batchStartedAt = 1000;
      const now = batchStartedAt + 5;
      const q = computeTopupQuota({
        record: { callsToday: 10, batchStartedAt },
        dailyCap,
        cooldownMs,
        now,
      });
      expect(q.callsRemaining).toBe(0);
      expect(q.windowActive).toBe(true);
      expect(q.rateLimited).toBe(false);
    });

    it('CDP rate-limit window zeros remaining even with unused batch cap', () => {
      const q = computeTopupQuota({
        record: { callsToday: 0, batchStartedAt: 1000, rateLimitedUntil: 50_000 },
        dailyCap,
        cooldownMs,
        now: 5000,
      });
      expect(q.callsRemaining).toBe(0);
      expect(q.rateLimited).toBe(true);
      expect(q.cooldownExpiresAt).toBe(50_000);
    });

    it('expired CDP rate-limit window restores batch remaining', () => {
      const q = computeTopupQuota({
        record: { callsToday: 2, batchStartedAt: 1000, rateLimitedUntil: 4000 },
        dailyCap,
        cooldownMs,
        now: 4000,
      });
      expect(q.rateLimited).toBe(false);
      expect(q.callsRemaining).toBe(8);
    });
  });

  it('round-trips rateLimitedUntil', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-topup-rl-'));
    writeFaucetTopupRecord(dir, ADDR, {
      callsToday: 0,
      batchStartedAt: 1_000,
      rateLimitedUntil: 99_000,
    });
    expect(readFaucetTopupState(dir).byAddress[ADDR.toLowerCase()]).toEqual({
      callsToday: 0,
      batchStartedAt: 1_000,
      rateLimitedUntil: 99_000,
    });
  });
});
