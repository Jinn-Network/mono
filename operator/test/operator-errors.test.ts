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
    expect(r.hint).toContain('JINN_EARNING_DIR');
    expect(r.hint).toContain('master_keystore.json');
    expect(r.hint).toContain('earning_state.json');
    expect(r.hint).toContain('Safe owner set');
    expect(r.hint).not.toContain('JINN_PASSWORD');
  });

  it('maps replacement underpriced', () => {
    const r = formatBootstrapOperatorMessage(
      new Error('replacement transaction underpriced'),
    );
    expect(r.summary.toLowerCase()).toContain('nonce');
    expect(r.hint).toBeDefined();
  });

  it('maps insufficient funds (specific viem phrasing)', () => {
    const r = formatBootstrapOperatorMessage(new Error('insufficient funds for gas * price + value'));
    expect(r.summary).toMatch(/ETH|eth/i);
    expect(r.hint).toBeDefined();
    expect(r.rawMessage).toBe('insufficient funds for gas * price + value');
    // jinn-mono-hjex.6: category must be set so SPA can render structured display.
    expect(r.category).toBe('insufficient_funds');
  });

  it('maps out-of-gas as a gas-supply problem, not a funding problem (jinn-mono-jz9f)', () => {
    const oog = new Error(
      'execution reverted: out of gas while creating contract during mech deploy',
    );
    const r = formatBootstrapOperatorMessage(oog);
    expect(r.summary.toLowerCase()).toContain('gas');
    // The summary must NOT pretend the operator is short on ETH.
    expect(r.summary.toLowerCase()).not.toContain('not enough eth');
    expect(r.summary.toLowerCase()).not.toContain('paying account');
    expect(r.hint).toBeDefined();
    // jinn-mono-hjex.6: category must be gas_too_low, not insufficient_funds.
    expect(r.category).toBe('gas_too_low');
  });

  it('maps `gas required exceeds allowance (0)` as insufficient funds, not OOG (jinn-mono-u34i / hjex.6 review)', () => {
    const r = formatBootstrapOperatorMessage(
      new Error('Execution reverted with reason: gas required exceeds allowance (0).'),
    );
    // (0) allowance from geth means the sender cannot pay for even 1 wei of
    // gas — that's a balance issue, not a gas-limit issue.
    expect(r.summary.toLowerCase()).toContain('eth');
    expect(r.summary.toLowerCase()).not.toContain('ran out of gas');
    expect(r.hint).toBeDefined();
    expect(r.hint!.toLowerCase()).toContain('send eth');
    // jinn-mono-hjex.6 review: this branch must classify as insufficient_funds
    // (zero spendable balance) so the SPA renders the funding-shortfall UI,
    // not the gas-retry UI.
    expect(r.category).toBe('insufficient_funds');
  });

  it('keeps `gas required exceeds allowance (50000)` as OOG (true gas-limit shortfall)', () => {
    const r = formatBootstrapOperatorMessage(
      new Error('gas required exceeds allowance (50000)'),
    );
    expect(r.summary.toLowerCase()).toContain('gas');
    expect(r.summary.toLowerCase()).not.toContain('not enough eth');
    expect(r.hint).toBeDefined();
  });

  it('does not misclassify generic execution-reverted errors as insufficient funds', () => {
    const r = formatBootstrapOperatorMessage(new Error('execution reverted: insufficient gas for inner call'));
    // The substring "insufficient" appears but this is gas, not balance — make
    // sure the funds matcher does not trip on it.
    expect(r.summary.toLowerCase()).not.toContain('paying account');
  });

  it('always preserves the raw error message in rawMessage', () => {
    const original = 'some unrecognised RPC failure with multiple\nlines\nof detail';
    const r = formatBootstrapOperatorMessage(new Error(original));
    expect(r.rawMessage).toBe(original);
  });

  it('maps unauthorized restake to earning-dir guidance', () => {
    const r = formatBootstrapOperatorMessage(
      new Error('Service 1 is evicted, but master EOA 0x123 is not authorized to reStake it. reStake revert: UnauthorizedAccount(address)'),
    );
    expect(r.summary).toContain('not authorized to reStake');
    expect(r.hint).toContain('JINN_EARNING_DIR');
    expect(r.hint).not.toContain('setCuratingAgents');
  });

  it('includes Error cause text', () => {
    const inner = new Error('GS013 inner');
    const outer = new Error('wrapper') as Error & { cause?: unknown };
    outer.cause = inner;
    const r = formatBootstrapOperatorMessage(outer);
    expect(r.summary).toContain('GS013');
  });

  it('truncates very long messages without referencing JINN_DEBUG', () => {
    const long = 'x'.repeat(300);
    const r = formatBootstrapOperatorMessage(new Error(long));
    expect(r.summary.length).toBeLessThanOrEqual(221);
    // Hint (if any) must not reference JINN_DEBUG — the envelope's
    // details.cause already carries the full error.
    if (r.hint !== undefined) {
      expect(r.hint).not.toContain('JINN_DEBUG');
    }
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
