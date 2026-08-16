import { describe, it, expect } from 'vitest';
import { formatLogData } from '../../src/erc8004/reputation.js';

describe('reputation defaultLog formatting (jinn-mono-kzan)', () => {
  it('renders a structured payload as inspectable JSON instead of [object Object]', () => {
    const rendered = formatLogData({
      harnessAgentId: '42',
      verdict: 'PASS',
      score: 100,
      scoreDecimals: 2,
      manifestCid: 'bafyabc',
      txHash: '0xdeadbeef',
    });

    expect(rendered).not.toBe('[object Object]');
    expect(rendered).toContain('"harnessAgentId":"42"');
    expect(rendered).toContain('"verdict":"PASS"');
    expect(rendered).toContain('"txHash":"0xdeadbeef"');
  });

  it('serialises BigInt values as decimal strings (BigInt-safe replacer)', () => {
    const rendered = formatLogData({ harnessAgentId: 42n, score: 100 });
    expect(rendered).toContain('"harnessAgentId":"42"');
    expect(rendered).toContain('"score":100');
  });

  it('returns an empty string for null / undefined data so the message stays bare', () => {
    expect(formatLogData(undefined)).toBe('');
    expect(formatLogData(null)).toBe('');
  });

  it('falls back to String(data) when JSON.stringify throws (e.g. circular refs)', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const rendered = formatLogData(circular);
    expect(rendered).toContain('[object Object]');
  });
});
