import { describe, it, expect } from 'vitest';
import {
  checkOracleReachable,
  checkOracleRoundCoversResolveTs,
} from '../../../../../src/harnesses/impls/prediction-v0-evaluator/checks/availability.js';

describe('availability.oracle_reachable', () => {
  it('PASS when the read resolves', async () => {
    const r = await checkOracleReachable(async () => ({ ok: true } as any));
    expect(r.status).toBe('PASS');
  });
  it('FAIL on error', async () => {
    const r = await checkOracleReachable(async () => { throw new Error('rpc down'); });
    expect(r.status).toBe('FAIL');
    expect(String((r.detail as any).message)).toMatch(/rpc down/);
  });
});

describe('availability.oracle_round_covers_resolve_ts', () => {
  it('PASS when spanning=true', () => {
    const r = checkOracleRoundCoversResolveTs({ spanning: true } as any);
    expect(r.status).toBe('PASS');
  });
  it('SKIP when spanning=false', () => {
    const r = checkOracleRoundCoversResolveTs({ spanning: false } as any);
    expect(r.status).toBe('SKIP');
  });
});
