import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { makePredictionApyV0Generator } from '../../src/solver-types/prediction-apy-v0-auto.js';

describe('makePredictionApyV0Generator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces a valid prediction.apy.v0 Task', async () => {
    vi.setSystemTime(new Date('2026-04-21T18:23:45Z'));
    const gen = makePredictionApyV0Generator({});
    const state = await gen();
    expect(state).not.toBeNull();
    expect(state!.solverType).toBe('prediction.apy.v0');
    expect(state!.spec?.solverType).toBeUndefined();
    expect(state!.window).toBeDefined();
    expect(state!.window!.endTs - state!.window!.startTs).toBe(600_000);
  });

  it('uses the window boundary as the stable task ID (default 10min bucket)', async () => {
    vi.setSystemTime(new Date('2026-04-21T18:23:45Z'));
    const genA = makePredictionApyV0Generator({});
    const a1 = await genA();
    vi.setSystemTime(new Date('2026-04-21T18:29:00Z'));
    const a2 = await genA();
    expect(a1!.id).toBe(a2!.id);
    // Cross bucket boundary (18:30) → different id.
    vi.setSystemTime(new Date('2026-04-21T18:30:01Z'));
    const a3 = await genA();
    expect(a3!.id).not.toBe(a1!.id);
  });

  it('produces a SignedTaskV1 document when signing credentials are provided', async () => {
    vi.setSystemTime(new Date('2026-04-21T18:23:45Z'));
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const safeAddress = '0x2222222222222222222222222222222222222222' as `0x${string}`;

    const gen = makePredictionApyV0Generator({
      agentEoa: account.address as `0x${string}`,
      safeAddress,
      agentPrivateKey: pk,
      solverNetManifestCid: 'bafyfixturecid',
    });
    const state = await gen();
    expect(state).not.toBeNull();
    expect(state!.signedTask).toBeDefined();
    const signed = state!.signedTask!;
    expect(signed.schemaVersion).toBe('task.v1');
    expect(signed.solverType).toBe('prediction.apy.v0');
    expect(signed.creator).toBeDefined();
    expect(signed.creator.safeAddress).toBe(safeAddress);
    expect(signed.creator.agentEoa.toLowerCase()).toBe(account.address.toLowerCase());
    expect(signed.signature).toBeDefined();
    expect(signed.signature.algo).toBe('secp256k1');
    expect(signed.signature.sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('does not produce a SignedTaskV1 when signing credentials are absent', async () => {
    vi.setSystemTime(new Date('2026-04-21T18:23:45Z'));
    const gen = makePredictionApyV0Generator({});
    const state = await gen();
    expect(state).not.toBeNull();
    expect(state!.signedTask).toBeUndefined();
  });

  it('respects custom windowDurationMs + resolveGapMs', async () => {
    vi.setSystemTime(new Date('2026-04-21T18:23:45Z'));
    const gen = makePredictionApyV0Generator({
      windowDurationMs: 3_600_000,
      resolveGapMs: 900_000,
    });
    const state = await gen();
    expect(state!.window!.endTs - state!.window!.startTs).toBe(3_600_000);
    expect((state!.spec as any).question.resolveTs).toBe(state!.window!.endTs + 900_000);
  });
});
