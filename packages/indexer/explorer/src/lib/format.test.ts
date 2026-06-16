import { describe, it, expect } from 'vitest';
import { pct, int, block, jinn, shortAddr, shortCid, relTime } from './format';

// ── pct ──────────────────────────────────────────────────────────────────────

describe('pct', () => {
  it('formats a ratio to 1 decimal percent', () => {
    expect(pct(0.96875)).toBe('96.9%');
  });
  it('formats 0 correctly', () => {
    expect(pct(0)).toBe('0.0%');
  });
  it('formats 1 correctly', () => {
    expect(pct(1)).toBe('100.0%');
  });
  it('respects custom digits', () => {
    expect(pct(0.5, 0)).toBe('50%');
    expect(pct(0.12345, 2)).toBe('12.35%');
  });
  it('returns dash for null', () => {
    expect(pct(null)).toBe('—');
  });
  it('returns dash for undefined', () => {
    expect(pct(undefined)).toBe('—');
  });
});

// ── int ──────────────────────────────────────────────────────────────────────

describe('int', () => {
  it('formats with thousands grouping', () => {
    expect(int(1234567)).toBe('1,234,567');
  });
  it('formats small numbers', () => {
    expect(int(42)).toBe('42');
  });
  it('formats zero', () => {
    expect(int(0)).toBe('0');
  });
  it('returns dash for null', () => {
    expect(int(null)).toBe('—');
  });
  it('returns dash for undefined', () => {
    expect(int(undefined)).toBe('—');
  });
});

// ── block ─────────────────────────────────────────────────────────────────────

describe('block', () => {
  it('formats block number string with grouping', () => {
    expect(block('12456789')).toBe('12,456,789');
  });
  it('accepts a number', () => {
    expect(block(7654321)).toBe('7,654,321');
  });
  it('returns dash for null', () => {
    expect(block(null)).toBe('—');
  });
  it('returns dash for empty string', () => {
    expect(block('')).toBe('—');
  });
  it('returns dash for undefined', () => {
    expect(block(undefined)).toBe('—');
  });
});

// ── jinn ─────────────────────────────────────────────────────────────────────

describe('jinn', () => {
  it('formats a large wei value correctly without precision loss', () => {
    // 100.50 JINN = 100500000000000000000 wei
    expect(jinn('100500000000000000000')).toBe('100.50 tJINN');
  });
  it('formats a value with trailing zeros in fraction', () => {
    // 1.00 JINN = 1000000000000000000 wei
    expect(jinn('1000000000000000000')).toBe('1.00 tJINN');
  });
  it('returns 0 JINN for "0"', () => {
    expect(jinn('0')).toBe('0 tJINN');
  });
  it('returns 0 JINN for null', () => {
    expect(jinn(null)).toBe('0 tJINN');
  });
  it('returns 0 JINN for empty string', () => {
    expect(jinn('')).toBe('0 tJINN');
  });
  it('handles a number in the thousands', () => {
    // 5000 JINN
    expect(jinn('5000000000000000000000')).toBe('5,000.00 tJINN');
  });
  it('respects custom digits', () => {
    // 1.5 JINN
    expect(jinn('1500000000000000000', 18, 1)).toBe('1.5 tJINN');
  });
  it('returns dash for non-numeric string', () => {
    expect(jinn('not-a-number')).toBe('—');
  });
});

// ── shortAddr ─────────────────────────────────────────────────────────────────

describe('shortAddr', () => {
  it('shortens a full hex address', () => {
    expect(shortAddr('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
  });
  it('returns dash for null', () => {
    expect(shortAddr(null)).toBe('—');
  });
  it('returns dash for undefined', () => {
    expect(shortAddr(undefined)).toBe('—');
  });
  it('passes through non-address strings', () => {
    expect(shortAddr('not-an-addr')).toBe('not-an-addr');
  });
  it('passes through short hex strings that look partial', () => {
    expect(shortAddr('0x1234')).toBe('0x1234');
  });
});

// ── shortCid ──────────────────────────────────────────────────────────────────

describe('shortCid', () => {
  it('shortens a CID with default head/tail', () => {
    // head=8, tail=6 by default
    const cid = 'bafkreiabcdefghijklmnopqrstuvwxyzx4lcv4';
    const result = shortCid(cid);
    // first 8: 'bafkreia', last 6: 'x4lcv4'
    expect(result).toBe('bafkreia…x4lcv4');
  });
  it('returns dash for null', () => {
    expect(shortCid(null)).toBe('—');
  });
  it('returns dash for undefined', () => {
    expect(shortCid(undefined)).toBe('—');
  });
  it('returns short CID as-is', () => {
    expect(shortCid('bafkrei')).toBe('bafkrei');
  });
  it('respects custom head and tail', () => {
    const cid = 'bafkreiabcdef123456';
    const result = shortCid(cid, 3, 3);
    expect(result).toBe('baf…456');
  });
});

// ── relTime ───────────────────────────────────────────────────────────────────

describe('relTime', () => {
  it('returns dash for null', () => {
    expect(relTime(null)).toBe('—');
  });
  it('returns dash for undefined', () => {
    expect(relTime(undefined)).toBe('—');
  });
  it('returns "just now" for very recent timestamps', () => {
    const now = new Date(Date.now() - 2000).toISOString();
    expect(relTime(now)).toBe('just now');
  });
  it('returns seconds ago', () => {
    const then = new Date(Date.now() - 14_000).toISOString();
    expect(relTime(then)).toBe('14s ago');
  });
  it('returns minutes ago', () => {
    const then = new Date(Date.now() - 3 * 60_000).toISOString();
    expect(relTime(then)).toBe('3m ago');
  });
  it('returns hours ago', () => {
    const then = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(relTime(then)).toBe('2h ago');
  });
  it('returns days ago', () => {
    const then = new Date(Date.now() - 5 * 86_400_000).toISOString();
    expect(relTime(then)).toBe('5d ago');
  });
  it('returns dash for invalid date string', () => {
    expect(relTime('not-a-date')).toBe('—');
  });
});
