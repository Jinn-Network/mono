import { describe, expect, it } from 'vitest';
import {
  parseEtherToWei,
  parsePositiveWeiString,
  parseTokenDecimalToWei,
  parseWithdrawArgv,
  validateWithdrawArgs,
  withdrawArgsNeedMasterTransfer,
} from '../../src/withdraw/args.js';

describe('parseEtherToWei', () => {
  it('parses whole ether', () => {
    expect(parseEtherToWei('1')).toBe(10n ** 18n);
    expect(parseEtherToWei('2')).toBe(2n * 10n ** 18n);
  });

  it('parses fractional ether', () => {
    expect(parseEtherToWei('0.5')).toBe(5n * 10n ** 17n);
    expect(parseEtherToWei('1.234567890123456789')).toBe(1234567890123456789n);
  });

  it('rejects invalid', () => {
    expect(() => parseEtherToWei('')).toThrow();
    expect(() => parseEtherToWei('abc')).toThrow();
    expect(() => parseEtherToWei('1.2345678901234567890')).toThrow(); // >18 dp
  });
});

describe('parseTokenDecimalToWei', () => {
  it('respects decimals', () => {
    expect(parseTokenDecimalToWei('1', 6)).toBe(1_000_000n);
    expect(parseTokenDecimalToWei('0.5', 18)).toBe(5n * 10n ** 17n);
  });

  it('rejects excess fractional digits', () => {
    expect(() => parseTokenDecimalToWei('1.0000001', 6)).toThrow();
  });
});

describe('parsePositiveWeiString', () => {
  it('parses digits', () => {
    expect(parsePositiveWeiString('100', 'x')).toBe(100n);
  });

  it('rejects zero and non-digits', () => {
    expect(() => parsePositiveWeiString('0', 'x')).toThrow();
    expect(() => parsePositiveWeiString('-1', 'x')).toThrow();
  });
});

describe('parseWithdrawArgv', () => {
  it('parses a full example', () => {
    const p = parseWithdrawArgv([
      '--to',
      '0x000000000000000000000000000000000000dEaD',
      '--jinn-amount',
      '10',
      '--eth-wei',
      '50000000000000000',
      '--sweep-agents',
      '--dry-run',
    ]);
    expect(p.to).toBe('0x000000000000000000000000000000000000dEaD');
    expect(p.jinnWei).toBe(10n * 10n ** 18n);
    expect(p.ethWei).toBe(50_000_000_000_000_000n);
    expect(p.sweepAgents).toBe(true);
    expect(p.dryRun).toBe(true);
  });

  it('accepts --config and checksums address', () => {
    const p = parseWithdrawArgv([
      '--to',
      '0x000000000000000000000000000000000000dead',
      '--drain-jinn',
      '--config',
      '/tmp/x.json',
    ]);
    expect(p.to).toBe('0x000000000000000000000000000000000000dEaD');
    expect(p.drainJinn).toBe(true);
  });

  it('accepts --password-fd (stripped so it does not trip unexpected-args)', () => {
    const p = parseWithdrawArgv([
      '--to',
      '0x000000000000000000000000000000000000dEaD',
      '--eth-amount',
      '0.01',
      '--password-fd',
      '3',
    ]);
    expect(p.to).toBe('0x000000000000000000000000000000000000dEaD');
    expect(p.ethWei).toBeGreaterThan(0n);
  });

  it('rejects conflicting jinn flags', () => {
    expect(() =>
      parseWithdrawArgv(['--to', '0x000000000000000000000000000000000000dEaD', '--drain-jinn', '--jinn-amount', '1']),
    ).toThrow();
  });

  it('treats --amount as JINN decimal amount', () => {
    const p = parseWithdrawArgv([
      '--to',
      '0x000000000000000000000000000000000000dEaD',
      '--amount',
      '2.5',
    ]);
    expect(p.jinnWei).toBe(25n * 10n ** 17n);
  });

  it('rejects --amount with --jinn-amount', () => {
    expect(() =>
      parseWithdrawArgv([
        '--to',
        '0x000000000000000000000000000000000000dEaD',
        '--amount',
        '1',
        '--jinn-amount',
        '1',
      ]),
    ).toThrow();
  });

  it('rejects unknown tokens', () => {
    expect(() => parseWithdrawArgv(['--to', '0x000000000000000000000000000000000000dEaD', '--what'])).toThrow();
  });
});

describe('validateWithdrawArgs', () => {
  it('requires --to when transferring', () => {
    expect(() =>
      validateWithdrawArgs(
        parseWithdrawArgv(['--jinn-amount', '1']),
      ),
    ).toThrow('--to');
  });

  it('allows help-less minimal sweep when to set', () => {
    const p = parseWithdrawArgv(['--to', '0x000000000000000000000000000000000000dEaD', '--sweep-agents']);
    expect(() => validateWithdrawArgs(p)).not.toThrow();
    expect(withdrawArgsNeedMasterTransfer(p)).toBe(false);
  });
});
