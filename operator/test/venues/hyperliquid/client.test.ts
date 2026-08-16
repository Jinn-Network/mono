/**
 * Real-API tests for the Hyperliquid client.
 *
 * These tests hit the HL testnet. Gate them with SKIP_HL_TESTS=1 for
 * offline CI runs. When the var is absent, the tests run and fail
 * informatively if the network is unreachable.
 *
 * Test address: 0x0000000000000000000000000000000000000001
 * Confirmed to have data on HL testnet (fills + portfolio history).
 */

import { describe, expect, it } from 'vitest';
import {
  HL_TESTNET_BASE_URL,
  HyperliquidClient,
} from '../../../src/venues/hyperliquid/client.js';

const SKIP = process.env['SKIP_HL_TESTS'] === '1';
const TEST_ADDR = '0x0000000000000000000000000000000000000001';

// Use conditional describe so all tests in this file are skipped together.
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('HyperliquidClient (real testnet)', () => {
  const client = new HyperliquidClient(HL_TESTNET_BASE_URL);

  it('clearinghouseState returns typed account state', async () => {
    const state = await client.clearinghouseState(TEST_ADDR);

    expect(state).toHaveProperty('marginSummary');
    expect(state.marginSummary).toHaveProperty('accountValue');
    expect(typeof state.marginSummary.accountValue).toBe('string');
    expect(state).toHaveProperty('withdrawable');
    expect(typeof state.time).toBe('number');
    expect(Array.isArray(state.assetPositions)).toBe(true);
  });

  it('spotClearinghouseState returns a balances array', async () => {
    const state = await client.spotClearinghouseState(TEST_ADDR);

    expect(state).toHaveProperty('balances');
    expect(Array.isArray(state.balances)).toBe(true);
    // Balances may be empty; if present, each entry has a coin + total.
    for (const bal of state.balances) {
      expect(typeof bal.coin).toBe('string');
      expect(typeof bal.total).toBe('string');
    }
  });

  it('userFills returns an array of fills (descending order)', async () => {
    const fills = await client.userFills(TEST_ADDR);

    expect(Array.isArray(fills)).toBe(true);
    // Descending order check: each fill's time should be >= the next.
    for (let i = 0; i < fills.length - 1; i++) {
      expect(fills[i]!.time).toBeGreaterThanOrEqual(fills[i + 1]!.time);
    }
    if (fills.length > 0) {
      const fill = fills[0]!;
      expect(typeof fill.coin).toBe('string');
      expect(typeof fill.px).toBe('string');
      expect(typeof fill.sz).toBe('string');
      expect(typeof fill.time).toBe('number');
      expect(['A', 'B']).toContain(fill.side);
    }
  });

  it('userFillsByTime returns fills ascending and detects clamp', async () => {
    // Request from a very old startTime to trigger clamping.
    const veryOldStartTime = 1_000_000_000_000; // year ~2001
    const result = await client.userFillsByTime(TEST_ADDR, veryOldStartTime);

    expect(Array.isArray(result.fills)).toBe(true);
    expect(typeof result.startTimeClamped).toBe('boolean');

    if (result.fills.length > 0) {
      // Fills should be ascending.
      for (let i = 0; i < result.fills.length - 1; i++) {
        expect(result.fills[i]!.time).toBeLessThanOrEqual(result.fills[i + 1]!.time);
      }
      // Clamp should be detected since we asked for year 2001.
      expect(result.startTimeClamped).toBe(true);
    }
  });

  it('userFillsByTime does not flag clamp for a recent startTime', async () => {
    // A startTime one hour ago should not be clamped on testnet.
    const recentStartTime = Date.now() - 60 * 60 * 1000;
    const result = await client.userFillsByTime(TEST_ADDR, recentStartTime);

    expect(Array.isArray(result.fills)).toBe(true);
    // May or may not have fills, but the clamp flag should be false
    // since the startTime is well within the retention window.
    expect(result.startTimeClamped).toBe(false);
  });

  it('portfolio returns buckets with accountValueHistory arrays', async () => {
    const portfolio = await client.portfolio(TEST_ADDR);

    expect(Array.isArray(portfolio)).toBe(true);
    expect(portfolio.length).toBeGreaterThan(0);

    const periodNames = portfolio.map(([name]) => name);
    expect(periodNames).toContain('day');

    for (const [name, data] of portfolio) {
      expect(typeof name).toBe('string');
      expect(Array.isArray(data.accountValueHistory)).toBe(true);
      for (const point of data.accountValueHistory) {
        expect(Array.isArray(point)).toBe(true);
        expect(point).toHaveLength(2);
        expect(typeof point[0]).toBe('number');
        expect(typeof point[1]).toBe('string');
      }
    }
  });

  it('portfolioPeriod returns day bucket with accountValueHistory array', async () => {
    const period = await client.portfolioPeriod(TEST_ADDR, 'day');

    expect(period).not.toBeNull();
    expect(Array.isArray(period!.accountValueHistory)).toBe(true);
  });

  it('meta returns universe array with named perps', async () => {
    const meta = await client.meta();

    expect(Array.isArray(meta.universe)).toBe(true);
    expect(meta.universe.length).toBeGreaterThan(0);

    const first = meta.universe[0]!;
    expect(typeof first.name).toBe('string');
    expect(typeof first.szDecimals).toBe('number');
    expect(typeof first.maxLeverage).toBe('number');
  });

  it('allMids returns a non-empty price map', async () => {
    const mids = await client.allMids();

    expect(typeof mids).toBe('object');
    expect(mids).not.toBeNull();
    const keys = Object.keys(mids);
    expect(keys.length).toBeGreaterThan(0);
    // All values should be numeric strings.
    for (const key of keys.slice(0, 5)) {
      expect(typeof mids[key]).toBe('string');
    }
  });
});
