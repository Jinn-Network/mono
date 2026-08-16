/**
 * Launched-record gate for the prediction.v1 auto-generator (Task 12 of
 * spec/2026-05-05-solvernet-creation-and-launch.md §11).
 *
 * The new factory `makePredictionV1GeneratorForLaunchedRecord` replaces the
 * predecessor's role-based `getRoles().includes('launching')` gate with a
 * record-based gate driven by two refs:
 *
 *   - `recordRef.current` — closure over the live LaunchedSolverNetRecord
 *     on disk. When the daemon flips `record.status` to `'paused'` (or
 *     `'retired'`/`'failed'`) and writes the change, the next generator
 *     tick MUST early-return without polling Polymarket. Same for
 *     `record.generatorEnabled === false`.
 *
 *   - `configRef.current` — hot-applyable subset of `PredictionV1AutoConfig`
 *     (cadence, allowlist/blocklist, max caps, submission window). When the
 *     API endpoint (Task 14) updates the ref and persists to disk, the next
 *     tick MUST read the new value — no daemon restart required.
 *
 * The static deps (agentEoa, safeAddress, agentPrivateKey, polymarket
 * fetchImpl) are captured at construction time. Anything mutable goes
 * through one of the two refs.
 */

import { describe, it, expect, vi } from 'vitest';
import { makePredictionV1GeneratorForLaunchedRecord } from '../../src/solver-types/prediction-v1-auto.js';
import type {
  LaunchedSolverNetRecord,
} from '../../src/solvernets/store.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const FIXED_NOW_ISO = '2026-05-06T12:00:00.000Z';

function buildLaunchedRecord(overrides: Partial<LaunchedSolverNetRecord> = {}): LaunchedSolverNetRecord {
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: 'sn-test-001',
    manifestCid: 'bafy-test',
    manifestHash: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
    launcherAgentId: '5474',
    launcherSafeAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
    launchedAt: FIXED_NOW_ISO,
    status: 'launched',
    statusUpdatedAt: FIXED_NOW_ISO,
    generatorEnabled: true,
    registry: {
      metadataTxHash: ('0x' + 'bb'.repeat(32)) as `0x${string}`,
      metadataBlockNumber: 100,
    },
    ...overrides,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyMarketsFetch() {
  return vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('prediction-v1-auto: launched-record gate', () => {
  it('does not poll Polymarket when record.status is paused', async () => {
    const fetchSpy = emptyMarketsFetch();
    const recordRef = { current: buildLaunchedRecord({ status: 'paused' }) };
    const configRef = { current: { cadenceMs: 0 } };
    const gen = makePredictionV1GeneratorForLaunchedRecord({
      recordRef,
      configRef,
      staticConfig: { fetchImpl: fetchSpy },
    });

    const result = await gen();

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not poll Polymarket when record.generatorEnabled is false', async () => {
    const fetchSpy = emptyMarketsFetch();
    const recordRef = {
      current: buildLaunchedRecord({ status: 'launched', generatorEnabled: false }),
    };
    const configRef = { current: { cadenceMs: 0 } };
    const gen = makePredictionV1GeneratorForLaunchedRecord({
      recordRef,
      configRef,
      staticConfig: { fetchImpl: fetchSpy },
    });

    const result = await gen();

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('polls Polymarket when record.status is launched and generatorEnabled is true', async () => {
    const fetchSpy = emptyMarketsFetch();
    const recordRef = { current: buildLaunchedRecord() };
    const configRef = { current: { cadenceMs: 0 } };
    const gen = makePredictionV1GeneratorForLaunchedRecord({
      recordRef,
      configRef,
      staticConfig: { fetchImpl: fetchSpy },
    });

    await gen();

    const calls = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
  });

  it('polls within one tick after recordRef.current is updated to launched', async () => {
    const fetchSpy = emptyMarketsFetch();
    // Start paused — first tick is gated.
    const recordRef = { current: buildLaunchedRecord({ status: 'paused' }) };
    const configRef = { current: { cadenceMs: 0 } };
    const gen = makePredictionV1GeneratorForLaunchedRecord({
      recordRef,
      configRef,
      staticConfig: { fetchImpl: fetchSpy },
    });

    await gen();
    expect((fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    // Daemon flips the record to launched (writes to disk + updates the ref).
    recordRef.current = buildLaunchedRecord({ status: 'launched' });
    await gen();

    const callsAfterFlip = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFlip).toBeGreaterThan(0);

    // Flip back to paused — generator stops polling on the next tick.
    recordRef.current = buildLaunchedRecord({ status: 'paused' });
    await gen();
    expect((fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFlip);
  });

  it('uses updated cadenceMs within one tick after configRef.current is updated', async () => {
    const fetchSpy = emptyMarketsFetch();
    const recordRef = { current: buildLaunchedRecord() };
    // Start with a long cadence that would gate any second tick.
    const configRef = { current: { cadenceMs: 6 * 60 * 60 * 1000 } };
    const gen = makePredictionV1GeneratorForLaunchedRecord({
      recordRef,
      configRef,
      staticConfig: { fetchImpl: fetchSpy },
    });

    // First tick polls (no prior poll timestamp).
    await gen();
    const callsAfterFirst = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second immediate tick is gated by long cadence.
    await gen();
    expect((fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);

    // Operator drops cadence to 0 — the next tick must poll regardless of how
    // recently we polled.
    configRef.current = { cadenceMs: 0 };
    await gen();
    expect((fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
