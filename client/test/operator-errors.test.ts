import { describe, expect, it } from 'vitest';
import { formatBootstrapOperatorMessage, isJinnDebug } from '../src/operator-errors.js';

describe('formatBootstrapOperatorMessage', () => {
  it('maps GS013', () => {
    const r = formatBootstrapOperatorMessage(new Error('Safe: GS013 error'));
    expect(r.summary).toContain('GS013');
    expect(r.hint).toBeDefined();
  });

  it('maps GS026', () => {
    const r = formatBootstrapOperatorMessage(new Error('GS026 invalid owner'));
    expect(r.summary).toContain('GS026');
    expect(r.hint).toBeDefined();
  });

  it('maps replacement underpriced', () => {
    const r = formatBootstrapOperatorMessage(
      new Error('replacement transaction underpriced'),
    );
    expect(r.summary.toLowerCase()).toContain('nonce');
    expect(r.hint).toBeDefined();
  });

  it('maps insufficient funds', () => {
    const r = formatBootstrapOperatorMessage(new Error('insufficient funds for gas'));
    expect(r.summary).toMatch(/ETH|eth/i);
    expect(r.hint).toBeDefined();
  });

  it('includes Error cause text', () => {
    const inner = new Error('GS013 inner');
    const outer = new Error('wrapper') as Error & { cause?: unknown };
    outer.cause = inner;
    const r = formatBootstrapOperatorMessage(outer);
    expect(r.summary).toContain('GS013');
  });

  it('truncates very long messages with hint', () => {
    const long = 'x'.repeat(300);
    const r = formatBootstrapOperatorMessage(new Error(long));
    expect(r.summary.length).toBeLessThanOrEqual(221);
    expect(r.hint).toContain('JINN_DEBUG');
  });
});

describe('isJinnDebug', () => {
  it('is true when JINN_DEBUG=1', () => {
    const prev = process.env['JINN_DEBUG'];
    process.env['JINN_DEBUG'] = '1';
    expect(isJinnDebug()).toBe(true);
    if (prev === undefined) delete process.env['JINN_DEBUG'];
    else process.env['JINN_DEBUG'] = prev;
  });

  it('is false when JINN_DEBUG is unset or 0', () => {
    const prev = process.env['JINN_DEBUG'];
    process.env['JINN_DEBUG'] = '0';
    expect(isJinnDebug()).toBe(false);
    delete process.env['JINN_DEBUG'];
    expect(isJinnDebug()).toBe(false);
    if (prev === undefined) delete process.env['JINN_DEBUG'];
    else process.env['JINN_DEBUG'] = prev;
  });
});
