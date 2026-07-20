import { describe, expect, it, vi } from 'vitest';
import {
  bridgeAttempts,
  type AttemptRef,
  type BridgeDeps,
} from '../src/bridge.js';
import {
  ManifestBatchPreparationError,
  ManifestBatchRecordingError,
} from '../src/publish.js';

const NOW = new Date('2026-07-20T00:00:00.000Z');
const TX = `0x${'ab'.repeat(32)}` as const;
const ROOT = `0x${'cd'.repeat(32)}` as const;

function ref(index: number, overrides: Partial<AttemptRef> = {}): AttemptRef {
  return {
    requestId: `0x${String(index).repeat(64)}`,
    chainId: 84532,
    instanceId: `Jinn-Network__mono-${index}`,
    model: 'test-model',
    manifestCid: `bafy-attempt-${index}`,
    polarity: index % 2 === 0 ? 'fail' : 'pass',
    ...overrides,
  };
}

function deps(overrides: Partial<BridgeDeps> = {}) {
  const publishEvidence = vi.fn().mockRejectedValue(
    new Error('per-record publisher must not run in manifest mode'),
  );
  const publishManifestBatch = vi.fn().mockImplementation(
    async (candidates: Array<{ ref: AttemptRef }>) => {
      const memberRefs = candidates.map(
        ({ ref: candidate }) => `bafy-member-${candidate.requestId.slice(2, 3)}`,
      );
      return {
        memberRefs,
        batches: [{
          manifestCid: 'bafy-manifest',
          anchorTx: TX,
          memberRefs,
          root: ROOT,
          gasUsed: 123_456n,
          feeWei: 987_648n,
        }],
      };
    },
  );
  const value: BridgeDeps = {
    slateInstanceIds: new Set(),
    now: () => NOW,
    anchorMode: 'manifest',
    fetchEvidence: async (candidate) => ({
      taskSummary: `summary ${candidate.instanceId}`,
      patch: `patch ${candidate.instanceId}`,
      repo: 'Jinn-Network/mono',
    }),
    publishEvidence,
    publishManifestBatch,
    ...overrides,
  };
  return { value, publishEvidence, publishManifestBatch };
}

describe('bridgeAttempts manifest mode', () => {
  it('applies exclusions/dedup first, then publishes one batch and maps one shared anchor', async () => {
    const heldOut = ref(9, { instanceId: 'held__repo-9' });
    const { value, publishEvidence, publishManifestBatch } = deps({
      slateInstanceIds: new Set([heldOut.instanceId]),
    });
    const duplicate = ref(1, { requestId: `0x${'f'.repeat(64)}` });

    const result = await bridgeAttempts(
      [ref(1), duplicate, ref(2), heldOut],
      value,
    );

    expect(publishEvidence).not.toHaveBeenCalled();
    expect(publishManifestBatch).toHaveBeenCalledTimes(1);
    const candidates = publishManifestBatch.mock.calls[0]?.[0] as Array<{
      ref: AttemptRef;
    }>;
    expect(candidates.map(({ ref: candidate }) => candidate.instanceId)).toEqual([
      'Jinn-Network__mono-1',
      'Jinn-Network__mono-2',
    ]);
    expect(result.bridged).toEqual([
      {
        instanceId: 'Jinn-Network__mono-1',
        polarity: 'pass',
        envelopeRef: 'bafy-member-1',
        anchorTx: TX,
      },
      {
        instanceId: 'Jinn-Network__mono-2',
        polarity: 'fail',
        envelopeRef: 'bafy-member-2',
        anchorTx: TX,
      },
    ]);
    expect(result).toMatchObject({
      manifestCid: 'bafy-manifest',
      anchorTx: TX,
      gasUsed: 123_456n,
      feeWei: 987_648n,
    });
    expect(result.manifestBatches).toEqual([
      expect.objectContaining({
        manifestCid: 'bafy-manifest',
        memberRefs: ['bafy-member-1', 'bafy-member-2'],
        confirmed: true,
      }),
    ]);
    expect(result.deduped).toHaveLength(1);
    expect(result.excludedHeldOut).toHaveLength(1);
  });

  it('keeps the existing per-record path as the default', async () => {
    const publishEvidence = vi.fn().mockResolvedValue({
      envelopeRef: 'bafy-per-record',
      anchorTx: null,
    });
    const publishManifestBatch = vi.fn();
    const { value } = deps({
      anchorMode: undefined,
      publishEvidence,
      publishManifestBatch,
    });

    const result = await bridgeAttempts([ref(1)], value);

    expect(publishEvidence).toHaveBeenCalledTimes(1);
    expect(publishManifestBatch).not.toHaveBeenCalled();
    expect(result.bridged[0]?.envelopeRef).toBe('bafy-per-record');
    expect(result.manifestCid).toBeUndefined();
  });

  it('fails the batch visibly for every candidate when the shared publication fails', async () => {
    const { value } = deps({
      publishManifestBatch: vi.fn().mockRejectedValue(new Error('manifest anchor failed')),
    });

    const result = await bridgeAttempts([ref(1), ref(2)], value);

    expect(result.bridged).toEqual([]);
    expect(result.errors).toEqual([
      { requestId: ref(1).requestId, error: 'manifest anchor failed' },
      { requestId: ref(2).requestId, error: 'manifest anchor failed' },
    ]);
  });

  it('preserves irreversible member refs when local finalization fails', async () => {
    const memberRefs = ['bafy-member-1', 'bafy-member-2'];
    const { value } = deps({
      publishManifestBatch: vi.fn().mockRejectedValue(
        new ManifestBatchRecordingError(
          {
            manifestCid: 'bafy-manifest',
            anchorTx: TX,
            memberRefs,
            root: ROOT,
            gasUsed: 123_456n,
            feeWei: 987_648n,
          },
          new Error('sqlite disk full'),
        ),
      ),
    });

    const result = await bridgeAttempts([ref(1), ref(2)], value);

    expect(result.bridged).toEqual([]);
    expect(result.manifestMemberRefs).toEqual(memberRefs);
    expect(result.manifestCid).toBe('bafy-manifest');
    expect(result.anchorTx).toBe(TX);
    expect(result.errors).toHaveLength(2);
  });

  it('surfaces member refs retained before a later upload failure', async () => {
    const { value } = deps({
      publishManifestBatch: vi.fn().mockRejectedValue(
        new ManifestBatchPreparationError(
          'member-upload',
          ['bafy-member-1'],
          new Error('second upload failed'),
          'batch-key',
        ),
      ),
    });

    const result = await bridgeAttempts([ref(1), ref(2)], value);

    expect(result.manifestMemberRefs).toEqual(['bafy-member-1']);
    expect(result.errors).toHaveLength(2);
  });

  it('propagates one-member manifest validation recovery facts and batch identity', async () => {
    const { value } = deps({
      publishManifestBatch: vi.fn().mockRejectedValue(
        new ManifestBatchPreparationError(
          'manifest-validation',
          ['bafy-member-1'],
          new Error('manifest CID is not canonical'),
          'batch-key',
        ),
      ),
    });

    const result = await bridgeAttempts([ref(1)], value);

    expect(result.manifestMemberRefs).toEqual(['bafy-member-1']);
    expect(result.manifestBatchKey).toBe('batch-key');
    expect(result.errors).toEqual([
      expect.objectContaining({
        requestId: ref(1).requestId,
        error: expect.stringContaining('manifest CID is not canonical'),
      }),
    ]);
  });

  it('maps split manifest anchors to the matching candidate ranges', async () => {
    const firstTx = `0x${'11'.repeat(32)}` as const;
    const secondTx = `0x${'22'.repeat(32)}` as const;
    const { value } = deps({
      publishManifestBatch: vi.fn().mockResolvedValue({
        memberRefs: ['bafy-member-1', 'bafy-member-2'],
        batches: [
          {
            manifestCid: 'bafy-manifest-1',
            anchorTx: firstTx,
            memberRefs: ['bafy-member-1'],
            root: ROOT,
            gasUsed: 100n,
            feeWei: 200n,
          },
          {
            manifestCid: 'bafy-manifest-2',
            anchorTx: secondTx,
            memberRefs: ['bafy-member-2'],
            root: ROOT,
            gasUsed: 110n,
            feeWei: 220n,
          },
        ],
      }),
    });

    const result = await bridgeAttempts([ref(1), ref(2)], value);

    expect(result.bridged.map((row) => row.anchorTx)).toEqual([
      firstTx,
      secondTx,
    ]);
    expect(result.manifestMemberRefs).toEqual([
      'bafy-member-1',
      'bafy-member-2',
    ]);
    expect(result.manifestBatches).toHaveLength(2);
    expect(result.manifestCid).toBeUndefined();
    expect(result.anchorTx).toBeUndefined();
  });
});
