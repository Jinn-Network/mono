import { describe, it, expect } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { computePrevSpanHash, computeGenesisHash } from '../../src/trajectory/hash-chain.js';
import { canonicalJson } from '../../src/util/canonical-json.js';
import type { Span } from '../../src/trajectory/schema.js';

describe('computeGenesisHash', () => {
  it('returns keccak256(JCS({runStart: taskCid}))', () => {
    const taskCid = 'bafy-task';
    const expected = keccak256(toBytes(canonicalJson({ runStart: taskCid })));
    expect(computeGenesisHash(taskCid)).toBe(expected);
  });

  it('is stable for the same Task CID', () => {
    expect(computeGenesisHash('bafy-x')).toBe(computeGenesisHash('bafy-x'));
  });

  it('differs for different Task CIDs', () => {
    expect(computeGenesisHash('bafy-x')).not.toBe(computeGenesisHash('bafy-y'));
  });
});

describe('computePrevSpanHash', () => {
  function mk(spanId: string): Span {
    return {
      traceId: '0'.repeat(32),
      spanId,
      parentSpanId: null,
      name: 'n',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: {
        'jinn.span.kind': 'jinn.phase',
        'jinn.prevSpanHash': '0x' + 'aa'.repeat(32),
      },
      events: [],
      status: { code: 'OK' },
    };
  }

  it('returns keccak256 of JCS(span)', () => {
    const s = mk('1'.repeat(16));
    const expected = keccak256(toBytes(canonicalJson(s)));
    expect(computePrevSpanHash(s)).toBe(expected);
  });

  it('is deterministic across re-computations', () => {
    const s = mk('2'.repeat(16));
    expect(computePrevSpanHash(s)).toBe(computePrevSpanHash(s));
  });

  it('changes when any span field changes', () => {
    const a = mk('3'.repeat(16));
    const b = { ...a, name: 'different' };
    expect(computePrevSpanHash(a)).not.toBe(computePrevSpanHash(b));
  });
});
