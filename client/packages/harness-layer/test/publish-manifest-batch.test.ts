import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ScrubPipeline } from '../../../src/trajectory/scrub/pipeline.js';
import { canonicalJson } from '../../../src/harnesses/engine/canonical-json.js';
import { capture, type CapturedTask, type PendingEnvelope } from '../src/capture.js';
import { MAX_RAW_IPFS_BLOCK_BYTES } from '../src/ipfs-cid.js';
import {
  ManifestBatchAnchorError,
  ManifestBatchPreparationError,
  ManifestBatchRecordingError,
  ManifestBatchSetError,
  publishManifestBatch,
  publishMemberEnvelope,
  type ManifestBatchJournalStore,
  type ManifestBatchPublishDeps,
} from '../src/publish.js';
import { createMemoryLedger } from '../src/ledger.js';
import {
  proveMember,
  verifyMember,
} from '../../../src/erc8004/manifest-consumer.js';
import { parseManifestV0, type ManifestV0 } from '../../../src/types/manifest.js';

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const TEST_SAFE = '0x1111111111111111111111111111111111111111' as const;
const TEST_TX = `0x${'ab'.repeat(32)}` as const;
const CONTROL_TX = `0x${'cd'.repeat(32)}` as const;
const SECOND_TX = `0x${'ef'.repeat(32)}` as const;
const PUBLICATION_SCOPE = {
  chainId: 84532,
  identityRegistryAddress: '0x8004800480048004800480048004800480048004',
  agentId: '42',
} as const;

function journalStore(
  states: Map<string, string>,
  save: (batchKey: string, stateJson: string) => void =
    (batchKey, stateJson) => states.set(batchKey, stateJson),
): ManifestBatchJournalStore {
  return {
    loadManifestBatchJournal: (batchKey) => states.get(batchKey) ?? null,
    saveManifestBatchJournal: save,
    compareAndSwapManifestBatchJournal: (
      batchKey,
      expectedStateJson,
      nextStateJson,
    ) => {
      const current = states.get(batchKey) ?? null;
      if (current !== expectedStateJson) return false;
      save(batchKey, nextStateJson);
      return true;
    },
  };
}

function memoryJournal() {
  const states = new Map<string, string>();
  return { store: journalStore(states), states };
}

function task(index: number): CapturedTask {
  return {
    session: {
      sessionId: `9f2c1e4a-7b3d-4e8f-a1c2-d5e6f7a8b9c${index}`,
      capturedAt: '2026-07-20T00:00:00.000Z',
    },
    task: {
      summary: `Bridge verified attempt ${index}`,
      distributionTags: ['mono', `attempt-${index}`],
    },
    environment: {
      harness: { name: 'jinn-test-harness', version: '0.0.1' },
      model: 'test-model',
      tools: ['run_command'],
    },
    steps: [
      {
        spanId: `span-${index}`,
        parentSpanId: null,
        name: 'tool:run_command',
        startTimeUnixNano: '1751450482000000000',
        endTimeUnixNano: '1751450483000000000',
        attributes: { 'tool.command': `test ${index}` },
        redactedKeys: [],
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    cost: { durationMs: 1_000 },
    provenance: 'imported',
  };
}

async function pending(index: number): Promise<PendingEnvelope> {
  return capture(task(index), { pipeline: new ScrubPipeline([]) });
}

function deps() {
  const ledger = createMemoryLedger();
  const calls = {
    publishEnvelope: [] as unknown[],
    anchorEnvelope: [] as unknown[],
    anchorManifest: [] as unknown[],
    manifestBodies: [] as ManifestV0[],
    manifestCids: [] as string[],
    anchorRecords: [] as unknown[],
    controlRecords: [] as unknown[],
    logs: [] as string[],
  };
  const publishDeps: ManifestBatchPublishDeps = {
    participant: { safeAddress: TEST_SAFE, agentEoa: TEST_ADDRESS },
    signer: { address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY },
    clientGitSha: 'test-sha',
    defaultArtifactEndpoint: 'http://127.0.0.1:7331',
    ledger,
    now: () => new Date('2026-07-20T00:00:00.000Z'),
    publishArtifact: async ({ payload }) => ({
      cid: `bafy-artifact-${(payload as { session: { sessionId: string } }).session.sessionId}`,
      sha256: 'a'.repeat(64),
    }),
    publishEnvelope: async (envelope) => {
      calls.publishEnvelope.push(envelope);
      const index = calls.publishEnvelope.length;
      return { cid: `bafy-envelope-${index}`, sha256: String(index).repeat(64) };
    },
    anchorEnvelope: async (input) => {
      calls.anchorEnvelope.push(input);
      return {
        txHash: CONTROL_TX,
        blockNumber: 10,
        gasUsed: 45_000n,
        feeWei: 90_000n,
        payloadHex: `0x${'ef'.repeat(32)}` as const,
      };
    },
    publishManifestBody: async (body) => {
      const parsed = parseManifestV0(body);
      calls.manifestBodies.push(parsed);
      const sha256 = createHash('sha256')
        .update(canonicalJson(parsed))
        .digest('hex');
      const cid = `f01551220${sha256}`;
      calls.manifestCids.push(cid);
      return { cid, sha256 };
    },
    anchorManifest: async (input) => {
      calls.anchorManifest.push(input);
      return {
        txHash: TEST_TX,
        blockNumber: 11,
        gasUsed: 123_456n,
        feeWei: 987_648n,
      };
    },
    recordManifestAnchor: (input) => {
      calls.anchorRecords.push(input);
    },
    recordControlAnchor: (input) => {
      calls.controlRecords.push(input);
    },
    manifestPublicationScope: PUBLICATION_SCOPE,
    log: (line) => calls.logs.push(line),
  };
  return { publishDeps, calls, ledger };
}

describe('publishMemberEnvelope', () => {
  it('uploads and signs one member without anchoring or appending a ledger row', async () => {
    const { publishDeps, calls, ledger } = deps();
    const result = await publishMemberEnvelope(await pending(1), publishDeps);

    expect(result.envelopeRef).toBe('bafy-envelope-1');
    expect(result.sha256).toBe('1'.repeat(64));
    expect(calls.publishEnvelope).toHaveLength(1);
    expect(calls.anchorEnvelope).toHaveLength(0);
    expect(calls.anchorManifest).toHaveLength(0);
    expect(ledger.list()).toHaveLength(0);
  });
});

describe('publishManifestBatch', () => {
  it('publishes N members, one enumerable manifest, and exactly one shared anchor', async () => {
    const { publishDeps, calls, ledger } = deps();
    const result = await publishManifestBatch(
      [
        { pending: await pending(1), polarity: 'pass', instanceId: 'mono-1' },
        { pending: await pending(2), polarity: 'fail', instanceId: 'mono-2' },
        { pending: await pending(3), polarity: 'pass', instanceId: 'mono-3' },
      ],
      publishDeps,
      { batchKind: 'bridge' },
    );

    expect(calls.publishEnvelope).toHaveLength(3);
    expect(calls.anchorEnvelope).toHaveLength(0);
    expect(calls.anchorManifest).toHaveLength(1);
    expect(calls.manifestBodies).toHaveLength(1);
    const body = calls.manifestBodies[0]!;
    expect(body.members.map((member) => member.cid)).toEqual([
      'bafy-envelope-1',
      'bafy-envelope-2',
      'bafy-envelope-3',
    ]);
    expect(body.members.map((member) => member.sha256)).toEqual([
      '1'.repeat(64),
      '2'.repeat(64),
      '3'.repeat(64),
    ]);
    expect(body.members.map((member) => member.polarity)).toEqual([
      'pass',
      'fail',
      'pass',
    ]);
    for (const member of body.members) {
      const { proof } = proveMember(body, member.cid);
      expect(verifyMember(member.cid, proof, result.batches[0]!.root)).toBe(true);
    }

    expect(result.memberRefs).toEqual([
      'bafy-envelope-1',
      'bafy-envelope-2',
      'bafy-envelope-3',
    ]);
    expect(result.publishedMembers.map((member) => member.envelopeRef)).toEqual(
      result.memberRefs,
    );
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]).toMatchObject({
      manifestCid: calls.manifestCids[0],
      anchorTx: TEST_TX,
      memberRefs: ['bafy-envelope-1', 'bafy-envelope-2', 'bafy-envelope-3'],
      gasUsed: 123_456n,
      feeWei: 987_648n,
    });
    expect(ledger.list()).toHaveLength(3);
    expect(ledger.list().map((entry) => entry.anchorTx)).toEqual([
      TEST_TX,
      TEST_TX,
      TEST_TX,
    ]);
    expect(calls.anchorRecords).toHaveLength(1);
    expect(calls.anchorRecords[0]).toMatchObject({
      manifestCid: calls.manifestCids[0],
      contentKind: 'manifest',
      metadataKey: `manifest:${calls.manifestCids[0]}`,
      txHash: TEST_TX,
      gasUsed: 123_456n,
      feeWei: 987_648n,
    });
    expect(calls.logs).toEqual([
      expect.stringMatching(
        new RegExp(
          `^\\[manifest] batch anchored cid=${calls.manifestCids[0]} members=3 gasUsed=123456 feeWei=987648$`,
        ),
      ),
    ]);
  });

  it('rejects an empty batch before any upload or anchor call', async () => {
    const { publishDeps, calls } = deps();
    await expect(
      publishManifestBatch([], publishDeps, { batchKind: 'bridge' }),
    ).rejects.toThrow(/at least one member/);
    expect(calls.publishEnvelope).toHaveLength(0);
    expect(calls.anchorManifest).toHaveLength(0);
  });

  it('adds one persisted control anchor without re-uploading or duplicating ledger rows', async () => {
    const { publishDeps, calls, ledger } = deps();
    const result = await publishManifestBatch(
      [
        { pending: await pending(1), polarity: 'pass', instanceId: 'mono-1' },
        { pending: await pending(2), polarity: 'fail', instanceId: 'mono-2' },
        { pending: await pending(3), polarity: 'pass', instanceId: 'mono-3' },
      ],
      publishDeps,
      { batchKind: 'bridge', measurePerRecordControl: true },
    );

    expect(calls.publishEnvelope).toHaveLength(3);
    expect(calls.anchorManifest).toHaveLength(1);
    expect(calls.anchorEnvelope).toHaveLength(1);
    expect(calls.anchorEnvelope[0]).toMatchObject({
      metadataKey: 'capture:bafy-envelope-1',
      envelopeCid: 'bafy-envelope-1',
      requireSuccessfulReceipt: true,
    });
    expect(calls.anchorRecords).toHaveLength(1);
    expect(calls.controlRecords).toHaveLength(1);
    expect(calls.controlRecords[0]).toMatchObject({
      envelopeRef: 'bafy-envelope-1',
      contentKind: 'capture',
      metadataKey: 'capture:bafy-envelope-1',
      txHash: CONTROL_TX,
      blockNumber: 10,
      gasUsed: 45_000n,
      feeWei: 90_000n,
    });
    expect(result.batches[0]?.control).toEqual({
      memberRef: 'bafy-envelope-1',
      anchorTx: CONTROL_TX,
      blockNumber: 10,
      gasUsed: 45_000n,
      feeWei: 90_000n,
    });
    expect(ledger.list()).toHaveLength(3);
    expect(ledger.list().every((entry) => entry.anchorTx === TEST_TX)).toBe(true);
  });

  it('fails the measurement when control receipt telemetry is unavailable', async () => {
    const { publishDeps } = deps();
    publishDeps.anchorEnvelope = async () => ({
      txHash: CONTROL_TX,
      blockNumber: 10,
      gasUsed: null,
      feeWei: null,
      payloadHex: `0x${'ef'.repeat(32)}`,
    });

    await expect(
      publishManifestBatch(
        [{ pending: await pending(1), polarity: 'pass', instanceId: 'mono-1' }],
        publishDeps,
        { batchKind: 'bridge', measurePerRecordControl: true },
      ),
    ).rejects.toThrow(/control.*telemetry/i);
  });

  it('retains the manifest CID and broadcast tx when confirmation fails', async () => {
    const { publishDeps, calls } = deps();
    const { store } = memoryJournal();
    publishDeps.manifestJournal = store;
    publishDeps.anchorManifest = async () => {
      throw Object.assign(new Error('receipt reverted'), { txHash: TEST_TX });
    };

    const error = await publishManifestBatch(
      [{
        pending: await pending(1),
        polarity: 'pass',
        instanceId: 'mono-1',
        sourceId: 'request-1',
      }],
      publishDeps,
      { batchKind: 'bridge' },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManifestBatchAnchorError);
    expect(error).toMatchObject({
      manifestCid: calls.manifestCids[0],
      txHash: TEST_TX,
      memberRefs: ['bafy-envelope-1'],
      batchKey: expect.any(String),
    });
    expect(String(error)).toContain('receipt reverted');
  });

  it('splits before upload when the canonical body would exceed one raw IPFS block', async () => {
    const { publishDeps, calls, ledger } = deps();
    const largeInstanceId = 'x'.repeat(140_000);

    const result = await publishManifestBatch(
      [
        {
          pending: await pending(1),
          polarity: 'pass',
          instanceId: `${largeInstanceId}1`,
        },
        {
          pending: await pending(2),
          polarity: 'fail',
          instanceId: `${largeInstanceId}2`,
        },
      ],
      publishDeps,
      { batchKind: 'bridge' },
    );

    expect(calls.manifestBodies).toHaveLength(2);
    expect(calls.anchorManifest).toHaveLength(2);
    expect(result.batches).toHaveLength(2);
    expect(result.memberRefs).toEqual([
      'bafy-envelope-1',
      'bafy-envelope-2',
    ]);
    expect(ledger.list()).toHaveLength(2);
    for (const body of calls.manifestBodies) {
      expect(Buffer.byteLength(canonicalJson(body), 'utf8')).toBeLessThanOrEqual(
        MAX_RAW_IPFS_BLOCK_BYTES,
      );
    }
    const unsplitBody = {
      ...calls.manifestBodies[0],
      merkleRoot: calls.manifestBodies[0]!.merkleRoot,
      members: calls.manifestBodies.flatMap((body) => body.members),
    };
    expect(Buffer.byteLength(canonicalJson(unsplitBody), 'utf8')).toBeGreaterThan(
      MAX_RAW_IPFS_BLOCK_BYTES,
    );
  });

  it('always uses the production raw-block ceiling even if a legacy test limit is injected', async () => {
    const { publishDeps, calls } = deps();
    const legacyDeps = Object.assign(publishDeps, {
      maxManifestBodyBytes: 400,
    }) as ManifestBatchPublishDeps;

    const result = await publishManifestBatch(
      [
        { pending: await pending(1), instanceId: 'mono-1' },
        { pending: await pending(2), instanceId: 'mono-2' },
      ],
      legacyDeps,
      { batchKind: 'bridge' },
    );

    expect(result.batches).toHaveLength(1);
    expect(calls.manifestBodies).toHaveLength(1);
  });

  it('rejects a non-raw manifest CID before broadcasting an anchor', async () => {
    const { publishDeps, calls } = deps();
    publishDeps.publishManifestBody = async (body) => {
      const digest = createHash('sha256')
        .update(canonicalJson(body))
        .digest('hex');
      return { cid: `f01701220${digest}` };
    };

    await expect(
      publishManifestBatch(
        [{ pending: await pending(1), polarity: 'pass', instanceId: 'mono-1' }],
        publishDeps,
        { batchKind: 'bridge' },
      ),
    ).rejects.toThrow(/raw codec/i);

    expect(calls.anchorManifest).toHaveLength(0);
  });

  it('retains one-member recovery facts for a non-canonical manifest CID', async () => {
    const { publishDeps, calls } = deps();
    const { store } = memoryJournal();
    publishDeps.manifestJournal = store;
    publishDeps.publishManifestBody = async (body) => {
      const digest = createHash('sha256')
        .update(canonicalJson(body))
        .digest('hex');
      return { cid: `f8100551220${digest}` };
    };

    const error = await publishManifestBatch(
      [{
        pending: await pending(1),
        polarity: 'pass',
        instanceId: 'mono-1',
        sourceId: 'request-1',
      }],
      publishDeps,
      { batchKind: 'bridge' },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManifestBatchPreparationError);
    expect(error).toMatchObject({
      stage: 'manifest-validation',
      memberRefs: ['bafy-envelope-1'],
      batchKey: expect.any(String),
    });
    expect(String(error)).toMatch(/minimal|canonical|varint/i);
    expect(calls.anchorManifest).toHaveLength(0);
  });

  it('retains one-member recovery facts when manifest upload fails', async () => {
    const { publishDeps, calls } = deps();
    const { store } = memoryJournal();
    publishDeps.manifestJournal = store;
    publishDeps.publishManifestBody = async () => {
      throw new Error('manifest upload unavailable');
    };

    const error = await publishManifestBatch(
      [{
        pending: await pending(1),
        sourceId: 'request-1',
      }],
      publishDeps,
      { batchKind: 'bridge' },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManifestBatchPreparationError);
    expect(error).toMatchObject({
      stage: 'manifest-upload',
      memberRefs: ['bafy-envelope-1'],
      batchKey: expect.any(String),
    });
    expect(String(error)).toContain('manifest upload unavailable');
    expect(calls.anchorManifest).toHaveLength(0);
  });

  it('persists a manifest upload intent before calling the external publisher', async () => {
    const { publishDeps, calls } = deps();
    const states = new Map<string, string>();
    publishDeps.manifestJournal = journalStore(
      states,
      (batchKey, stateJson) => {
        const state = JSON.parse(stateJson) as {
          partitions?: Array<{ manifestUpload?: { status?: string } }>;
        };
        if (state.partitions?.[0]?.manifestUpload?.status === 'intent') {
          throw new Error('manifest upload intent journal write failed');
        }
        states.set(batchKey, stateJson);
      },
    );

    const error = await publishManifestBatch(
      [{ pending: await pending(1), sourceId: 'request-1' }],
      publishDeps,
      { batchKind: 'bridge' },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManifestBatchPreparationError);
    expect(error).toMatchObject({
      stage: 'manifest-upload',
      memberRefs: ['bafy-envelope-1'],
      batchKey: expect.any(String),
    });
    expect(String(error)).toContain('manifest upload intent journal write failed');
    expect(calls.manifestBodies).toHaveLength(0);
    expect(calls.anchorManifest).toHaveLength(0);
  });

  it('reconciles an uploaded manifest after its completion journal write fails', async () => {
    const { publishDeps, calls } = deps();
    const states = new Map<string, string>();
    let failUploadedSave = true;
    publishDeps.manifestJournal = journalStore(
      states,
      (batchKey, stateJson) => {
        const state = JSON.parse(stateJson) as {
          partitions?: Array<{ manifestUpload?: { status?: string } }>;
        };
        if (
          failUploadedSave &&
          state.partitions?.[0]?.manifestUpload?.status === 'uploaded'
        ) {
          failUploadedSave = false;
          throw new Error('manifest completion journal write failed');
        }
        states.set(batchKey, stateJson);
      },
    );
    const reconcileManifestBody = vi.fn(async () => ({ status: 'present' as const }));
    publishDeps.reconcileManifestBody = reconcileManifestBody;
    const members = [
      { pending: await pending(1), sourceId: 'request-1' },
    ];

    const first = await publishManifestBatch(
      members,
      publishDeps,
      { batchKind: 'bridge' },
    ).catch((caught: unknown) => caught);
    expect(first).toBeInstanceOf(ManifestBatchPreparationError);
    expect(first).toMatchObject({
      stage: 'manifest-upload',
      memberRefs: ['bafy-envelope-1'],
      batchKey: expect.any(String),
    });

    await publishManifestBatch(members, publishDeps, { batchKind: 'bridge' });

    expect(calls.manifestBodies).toHaveLength(1);
    expect(reconcileManifestBody).toHaveBeenCalledOnce();
    expect(reconcileManifestBody).toHaveBeenCalledWith(
      calls.manifestCids[0],
      expect.any(Uint8Array),
    );
    expect(calls.anchorManifest).toHaveLength(1);
  });

  it('fails closed when a manifest upload intent cannot be authoritatively reconciled', async () => {
    const { publishDeps, calls } = deps();
    const states = new Map<string, string>();
    let failUploadedSave = true;
    publishDeps.manifestJournal = journalStore(
      states,
      (batchKey, stateJson) => {
        const state = JSON.parse(stateJson) as {
          partitions?: Array<{ manifestUpload?: { status?: string } }>;
        };
        if (
          failUploadedSave &&
          state.partitions?.[0]?.manifestUpload?.status === 'uploaded'
        ) {
          failUploadedSave = false;
          throw new Error('manifest completion journal write failed');
        }
        states.set(batchKey, stateJson);
      },
    );
    const members = [
      { pending: await pending(1), sourceId: 'request-1' },
    ];

    await expect(
      publishManifestBatch(members, publishDeps, { batchKind: 'bridge' }),
    ).rejects.toBeInstanceOf(ManifestBatchPreparationError);
    publishDeps.reconcileManifestBody = async () => ({
      status: 'unknown',
      reason: 'gateway reads cannot prove absence',
    });

    await expect(
      publishManifestBatch(members, publishDeps, { batchKind: 'bridge' }),
    ).rejects.toThrow(/unknown|cannot prove absence|reconcil/i);

    expect(calls.manifestBodies).toHaveLength(1);
    expect(calls.anchorManifest).toHaveLength(0);
  });

  it('uploads a journaled manifest only after authoritative reconciliation proves absence', async () => {
    const { publishDeps, calls } = deps();
    const states = new Map<string, string>();
    let failBeforeUpload = true;
    publishDeps.manifestJournal = journalStore(
      states,
      (batchKey, stateJson) => {
        const state = JSON.parse(stateJson) as {
          partitions?: Array<{ manifestUpload?: { status?: string } }>;
        };
        if (
          failBeforeUpload &&
          state.partitions?.[0]?.manifestUpload?.status === 'intent'
        ) {
          failBeforeUpload = false;
          states.set(batchKey, stateJson);
          throw new Error('crash after durable manifest intent');
        }
        states.set(batchKey, stateJson);
      },
    );
    const members = [
      { pending: await pending(1), sourceId: 'request-1' },
    ];

    await expect(
      publishManifestBatch(members, publishDeps, { batchKind: 'bridge' }),
    ).rejects.toBeInstanceOf(ManifestBatchPreparationError);
    expect(calls.manifestBodies).toHaveLength(0);
    publishDeps.reconcileManifestBody = async () => ({ status: 'absent' });

    await publishManifestBatch(members, publishDeps, { batchKind: 'bridge' });

    expect(calls.manifestBodies).toHaveLength(1);
    expect(calls.anchorManifest).toHaveLength(1);
  });

  it('retains every uploaded ref when the first split manifest needs recovery', async () => {
    const { publishDeps } = deps();
    const largeInstanceId = 'x'.repeat(140_000);
    publishDeps.recordManifestAnchor = () => {
      throw new Error('receipt store unavailable');
    };

    const error = await publishManifestBatch(
      [
        { pending: await pending(1), instanceId: `${largeInstanceId}1` },
        { pending: await pending(2), instanceId: `${largeInstanceId}2` },
      ],
      publishDeps,
      { batchKind: 'bridge' },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManifestBatchSetError);
    expect(error).toMatchObject({
      completed: [],
      memberRefs: ['bafy-envelope-1', 'bafy-envelope-2'],
      failed: expect.any(ManifestBatchRecordingError),
    });
  });

  it('retains partial member refs when a later envelope upload fails', async () => {
    const { publishDeps } = deps();
    let uploads = 0;
    publishDeps.publishEnvelope = async () => {
      uploads += 1;
      if (uploads === 2) throw new Error('second envelope upload failed');
      return { cid: 'bafy-envelope-first', sha256: '1'.repeat(64) };
    };

    const error = await publishManifestBatch(
      [
        { pending: await pending(1), sourceId: 'request-1' },
        { pending: await pending(2), sourceId: 'request-2' },
      ],
      publishDeps,
      { batchKind: 'bridge' },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManifestBatchPreparationError);
    expect(error).toMatchObject({
      memberRefs: ['bafy-envelope-first'],
      stage: 'member-upload',
    });
  });

  it('resumes only unfinished partitions and never re-anchors a confirmed partition', async () => {
    const { publishDeps, calls, ledger } = deps();
    const { store } = memoryJournal();
    publishDeps.manifestJournal = store;
    const largeInstanceId = 'x'.repeat(140_000);
    let anchorCall = 0;
    publishDeps.anchorManifest = async ({ onBroadcast }) => {
      anchorCall += 1;
      const txHash = anchorCall === 1 ? TEST_TX : SECOND_TX;
      onBroadcast?.(txHash);
      if (anchorCall === 2) throw Object.assign(new Error('temporary send failure'), { txHash });
      return {
        txHash,
        blockNumber: 11 + anchorCall,
        gasUsed: 123_456n,
        feeWei: 987_648n,
      };
    };
    publishDeps.reconcileAnchor = async () => ({ status: 'reverted', txHash: SECOND_TX });
    const members = [
      {
        pending: await pending(1),
        instanceId: `${largeInstanceId}1`,
        sourceId: 'request-1',
      },
      {
        pending: await pending(2),
        instanceId: `${largeInstanceId}2`,
        sourceId: 'request-2',
      },
    ];

    const first = await publishManifestBatch(
      members,
      publishDeps,
      { batchKind: 'bridge' },
    ).catch((caught: unknown) => caught);
    expect(first).toBeInstanceOf(ManifestBatchSetError);
    expect(first).toMatchObject({ completed: [expect.objectContaining({ anchorTx: TEST_TX })] });

    const resumed = await publishManifestBatch(
      members,
      publishDeps,
      { batchKind: 'bridge' },
    );

    expect(anchorCall).toBe(3);
    expect(resumed.batches.map((batch) => batch.anchorTx)).toEqual([TEST_TX, SECOND_TX]);
    expect(calls.publishEnvelope).toHaveLength(2);
    expect(ledger.list()).toHaveLength(2);
  });

  it('fails closed on an unresolved broadcast instead of retrying it', async () => {
    const { publishDeps } = deps();
    const { store } = memoryJournal();
    publishDeps.manifestJournal = store;
    let anchorCalls = 0;
    publishDeps.anchorManifest = async ({ onBroadcast }) => {
      anchorCalls += 1;
      onBroadcast?.(TEST_TX);
      throw Object.assign(new Error('receipt unavailable'), { txHash: TEST_TX });
    };
    publishDeps.reconcileAnchor = async () => ({ status: 'pending', txHash: TEST_TX });
    const members = [
      { pending: await pending(1), instanceId: 'mono-1', sourceId: 'request-1' },
    ];

    await expect(
      publishManifestBatch(members, publishDeps, { batchKind: 'bridge' }),
    ).rejects.toBeInstanceOf(ManifestBatchAnchorError);
    await expect(
      publishManifestBatch(members, publishDeps, { batchKind: 'bridge' }),
    ).rejects.toThrow(/pending|unconfirmed|reconcile/i);

    expect(anchorCalls).toBe(1);
  });

  it('persists an anchor intent before broadcasting the manifest transaction', async () => {
    const { publishDeps, calls } = deps();
    const states = new Map<string, string>();
    publishDeps.manifestJournal = journalStore(
      states,
      (batchKey, stateJson) => {
        const state = JSON.parse(stateJson) as {
          partitions?: Array<{ transaction?: { status?: string } }>;
        };
        if (state.partitions?.[0]?.transaction?.status === 'intent') {
          throw new Error('anchor intent journal write failed');
        }
        states.set(batchKey, stateJson);
      },
    );

    const error = await publishManifestBatch(
      [{ pending: await pending(1), sourceId: 'request-1' }],
      publishDeps,
      { batchKind: 'bridge' },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManifestBatchAnchorError);
    expect(error).toMatchObject({
      manifestCid: calls.manifestCids[0],
      txHash: null,
      memberRefs: ['bafy-envelope-1'],
      batchKey: expect.any(String),
    });
    expect(String(error)).toContain('anchor intent journal write failed');
    expect(calls.anchorManifest).toHaveLength(0);
  });

  it('keeps the callback hash in the error and never re-broadcasts a hashless intent', async () => {
    const { publishDeps, calls } = deps();
    const states = new Map<string, string>();
    let failBroadcastSave = true;
    publishDeps.manifestJournal = journalStore(
      states,
      (batchKey, stateJson) => {
        const state = JSON.parse(stateJson) as {
          partitions?: Array<{ transaction?: { status?: string } }>;
        };
        if (
          failBroadcastSave &&
          state.partitions?.[0]?.transaction?.status === 'broadcast'
        ) {
          failBroadcastSave = false;
          throw new Error('broadcast hash journal write failed');
        }
        states.set(batchKey, stateJson);
      },
    );
    let anchorCalls = 0;
    publishDeps.anchorManifest = async ({ onBroadcast }) => {
      anchorCalls += 1;
      onBroadcast?.(TEST_TX);
      return {
        txHash: TEST_TX,
        blockNumber: 11,
        gasUsed: 123_456n,
        feeWei: 987_648n,
      };
    };
    const members = [
      { pending: await pending(1), sourceId: 'request-1' },
    ];

    const first = await publishManifestBatch(
      members,
      publishDeps,
      { batchKind: 'bridge' },
    ).catch((caught: unknown) => caught);
    const [batchKey] = states.keys();
    expect(first).toBeInstanceOf(ManifestBatchAnchorError);
    expect(first).toMatchObject({
      manifestCid: calls.manifestCids[0],
      txHash: TEST_TX,
      memberRefs: ['bafy-envelope-1'],
      batchKey,
    });

    const resumed = await publishManifestBatch(
      members,
      publishDeps,
      { batchKind: 'bridge' },
    ).catch((caught: unknown) => caught);
    expect(resumed).toBeInstanceOf(ManifestBatchAnchorError);
    expect(resumed).toMatchObject({
      manifestCid: calls.manifestCids[0],
      txHash: null,
      memberRefs: ['bafy-envelope-1'],
      batchKey,
    });
    expect(String(resumed)).toMatch(/intent|reconcil|cannot safely retry/i);
    expect(anchorCalls).toBe(1);
  });

  it('rejects duplicate durable source IDs before publishing anything', async () => {
    const { publishDeps, calls } = deps();
    const journal = memoryJournal();
    publishDeps.manifestJournal = journal.store;

    await expect(
      publishManifestBatch(
        [
          { pending: await pending(1), sourceId: 'request-1' },
          { pending: await pending(2), sourceId: 'request-1' },
        ],
        publishDeps,
        { batchKind: 'bridge' },
      ),
    ).rejects.toThrow(/duplicate.*sourceId/i);

    expect(calls.publishEnvelope).toHaveLength(0);
    expect(calls.anchorManifest).toHaveLength(0);
    expect(journal.states).toHaveProperty('size', 0);
  });

  it('allows only one concurrent writer to anchor the same durable batch', async () => {
    const { publishDeps, calls, ledger } = deps();
    const journal = memoryJournal();
    publishDeps.manifestJournal = journal.store;
    let releaseEnvelopeUploads: (() => void) | undefined;
    const bothEnvelopeUploadsStarted = new Promise<void>((resolve) => {
      releaseEnvelopeUploads = resolve;
    });
    let envelopeUploadCount = 0;
    publishDeps.publishEnvelope = async () => {
      envelopeUploadCount += 1;
      if (envelopeUploadCount === 2) releaseEnvelopeUploads?.();
      await bothEnvelopeUploadsStarted;
      return {
        cid: 'bafy-envelope-shared',
        sha256: 'a'.repeat(64),
      };
    };
    let anchorCalls = 0;
    publishDeps.anchorManifest = async ({ onBroadcast }) => {
      anchorCalls += 1;
      const txHash = `0x${String(anchorCalls).padStart(64, '0')}` as const;
      onBroadcast?.(txHash);
      return {
        txHash,
        blockNumber: anchorCalls,
        gasUsed: 123_456n,
        feeWei: 987_648n,
      };
    };
    const members = [
      { pending: await pending(1), sourceId: 'request-1' },
    ];

    const outcomes = await Promise.allSettled([
      publishManifestBatch(members, publishDeps, { batchKind: 'bridge' }),
      publishManifestBatch(members, publishDeps, { batchKind: 'bridge' }),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const [rejected] = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(String(rejected?.reason)).toMatch(
      /manifest journal conflict: concurrent writer advanced batch/,
    );
    expect(anchorCalls).toBe(1);
    expect(calls.anchorRecords).toHaveLength(1);
    expect(ledger.list()).toHaveLength(1);
    const [persisted] = journal.states.values();
    const journalState = JSON.parse(persisted!) as {
      partitions: Array<{
        transaction: { status: string; txHash: string };
      }>;
    };
    expect(journalState.partitions[0]?.transaction).toEqual(
      expect.objectContaining({
        status: 'confirmed',
        txHash: `0x${'0'.repeat(63)}1`,
      }),
    );
  });

  it('fails closed when sanitized member inputs change under the same source IDs', async () => {
    const { publishDeps, calls } = deps();
    const journal = memoryJournal();
    publishDeps.manifestJournal = journal.store;
    const originalPending = await pending(1);
    const original = {
      pending: originalPending,
      sourceId: 'request-1',
      polarity: 'pass' as const,
      instanceId: 'mono-1',
    };
    await publishManifestBatch([original], publishDeps, { batchKind: 'bridge' });

    const changedInputs = [
      { ...original, pending: await pending(2) },
      { ...original, polarity: 'fail' as const },
      { ...original, instanceId: 'mono-2' },
    ];
    for (const changed of changedInputs) {
      await expect(
        publishManifestBatch([changed], publishDeps, { batchKind: 'bridge' }),
      ).rejects.toThrow(/journal.*conflict|frozen.*input/i);
    }

    expect(calls.publishEnvelope).toHaveLength(1);
    expect(calls.anchorManifest).toHaveLength(1);
  });

  it('freezes non-secret redaction facts without persisting redaction.before', async () => {
    const { publishDeps, calls } = deps();
    const journal = memoryJournal();
    publishDeps.manifestJournal = journal.store;
    const captured = await pending(1);
    const member = {
      pending: {
        ...captured,
        redactions: [{
          field: 'task.summary',
          stage: 'secretlint',
          detail: 'token',
          before: 'SECRET_A',
          after: '[REDACTED]',
        }],
      },
      sourceId: 'request-1',
    };

    await publishManifestBatch([member], publishDeps, { batchKind: 'bridge' });
    const [stateJson] = journal.states.values();
    expect(stateJson).not.toContain('SECRET_A');
    expect(stateJson).toContain('secretlint');
    expect(stateJson).toContain('task.summary');

    await publishManifestBatch(
      [{
        ...member,
        pending: {
          ...member.pending,
          redactions: [{
            ...member.pending.redactions[0]!,
            before: 'SECRET_B',
          }],
        },
      }],
      publishDeps,
      { batchKind: 'bridge' },
    );

    expect(calls.publishEnvelope).toHaveLength(1);
    expect(calls.anchorManifest).toHaveLength(1);
    expect([...journal.states.values()].join('')).not.toContain('SECRET_B');
  });

  it('uses a distinct recovery identity for the same inputs on another anchor scope', async () => {
    const { publishDeps, calls } = deps();
    const journal = memoryJournal();
    publishDeps.manifestJournal = journal.store;
    const members = [
      { pending: await pending(1), sourceId: 'request-1' },
    ];

    await publishManifestBatch(members, publishDeps, { batchKind: 'bridge' });
    publishDeps.manifestPublicationScope = {
      ...PUBLICATION_SCOPE,
      chainId: 8453,
    };
    await publishManifestBatch(members, publishDeps, { batchKind: 'bridge' });

    expect(journal.states).toHaveProperty('size', 2);
    expect(calls.publishEnvelope).toHaveLength(2);
    expect(calls.anchorManifest).toHaveLength(2);
  });

  it('rejects a persisted journal whose frozen scope or member digest was tampered', async () => {
    const { publishDeps } = deps();
    const journal = memoryJournal();
    publishDeps.manifestJournal = journal.store;
    const members = [
      { pending: await pending(1), sourceId: 'request-1' },
    ];
    await publishManifestBatch(members, publishDeps, { batchKind: 'bridge' });
    const [[batchKey, stateJson]] = [...journal.states.entries()];
    const state = JSON.parse(stateJson!) as {
      publicationScope: { agentId: string };
      memberInputsDigest: string;
    };
    state.publicationScope = {
      ...PUBLICATION_SCOPE,
      agentId: '999',
    };
    state.memberInputsDigest = '0'.repeat(64);
    journal.states.set(batchKey!, JSON.stringify(state));

    await expect(
      publishManifestBatch(members, publishDeps, { batchKind: 'bridge' }),
    ).rejects.toThrow(/journal.*conflict|scope|digest/i);
  });

  it('rejects a journal whose frozen partition plan was changed', async () => {
    const { publishDeps } = deps();
    const journal = memoryJournal();
    publishDeps.manifestJournal = journal.store;
    const members = [
      { pending: await pending(1), instanceId: 'mono-1', sourceId: 'request-1' },
    ];
    await publishManifestBatch(members, publishDeps, { batchKind: 'bridge' });
    const [[batchKey, stateJson]] = [...journal.states.entries()];
    const state = JSON.parse(stateJson!) as {
      partitions: Array<{ body: { batchKind: string } }>;
    };
    state.partitions[0]!.body.batchKind = 'tampered';
    journal.states.set(batchKey!, JSON.stringify(state));

    await expect(
      publishManifestBatch(members, publishDeps, { batchKind: 'bridge' }),
    ).rejects.toThrow(/journal.*conflict|frozen.*plan/i);
  });

  it('rejects legacy v2 journal rows because they lack write-ahead intents', async () => {
    const { publishDeps, calls } = deps();
    const journal = memoryJournal();
    publishDeps.manifestJournal = journal.store;
    const members = [
      { pending: await pending(1), sourceId: 'request-1' },
    ];
    await publishManifestBatch(members, publishDeps, { batchKind: 'bridge' });
    const [[batchKey, stateJson]] = [...journal.states.entries()];
    const state = JSON.parse(stateJson!) as { version: number };
    state.version = 2;
    journal.states.set(batchKey!, JSON.stringify(state));

    await expect(
      publishManifestBatch(members, publishDeps, { batchKind: 'bridge' }),
    ).rejects.toThrow(/legacy v2|write-ahead|cannot.*recover/i);

    expect(calls.manifestBodies).toHaveLength(1);
    expect(calls.anchorManifest).toHaveLength(1);
  });

  it('retains exact recovery facts when persisting the frozen plan fails', async () => {
    const { publishDeps, calls } = deps();
    const states = new Map<string, string>();
    let saveCalls = 0;
    publishDeps.manifestJournal = journalStore(
      states,
      (batchKey, stateJson) => {
        saveCalls += 1;
        if (saveCalls === 3) {
          throw new Error('frozen plan journal write failed');
        }
        states.set(batchKey, stateJson);
      },
    );
    const members = [
      { pending: await pending(1), sourceId: 'request-1' },
    ];

    const error = await publishManifestBatch(
      members,
      publishDeps,
      { batchKind: 'bridge' },
    ).catch((caught: unknown) => caught);
    const [batchKey] = states.keys();

    expect(error).toBeInstanceOf(ManifestBatchPreparationError);
    expect(error).toMatchObject({
      stage: 'partition',
      memberRefs: ['bafy-envelope-1'],
      batchKey,
    });
    expect(String(error)).toContain('frozen plan journal write failed');
    expect(calls.publishEnvelope).toHaveLength(1);
    expect(calls.anchorManifest).toHaveLength(0);

    await publishManifestBatch(members, publishDeps, { batchKind: 'bridge' });

    expect(calls.publishEnvelope).toHaveLength(1);
    expect(calls.anchorManifest).toHaveLength(1);
  });

  it('does not duplicate a ledger row after append succeeds but finalization throws', async () => {
    const { publishDeps, calls, ledger } = deps();
    const journal = memoryJournal();
    publishDeps.manifestJournal = journal.store;
    let anchorCalls = 0;
    publishDeps.anchorManifest = async ({ onBroadcast }) => {
      anchorCalls += 1;
      onBroadcast?.(TEST_TX);
      return {
        txHash: TEST_TX,
        blockNumber: 11,
        gasUsed: 123_456n,
        feeWei: 987_648n,
      };
    };
    let failAfterAppend = true;
    publishDeps.ledger = {
      list: ledger.list,
      append: (entry) => {
        ledger.append(entry);
        if (failAfterAppend) {
          failAfterAppend = false;
          throw new Error('crash after append');
        }
      },
    };
    const members = [
      { pending: await pending(1), instanceId: 'mono-1', sourceId: 'request-1' },
    ];

    const error = await publishManifestBatch(
      members,
      publishDeps,
      { batchKind: 'bridge' },
    ).catch((caught: unknown) => caught);
    const [batchKey] = journal.states.keys();

    expect(error).toBeInstanceOf(ManifestBatchRecordingError);
    expect(error).toMatchObject({
      memberRefs: ['bafy-envelope-1'],
      batchKey,
      result: {
        batchKey,
        memberRefs: ['bafy-envelope-1'],
      },
    });
    await publishManifestBatch(members, publishDeps, { batchKind: 'bridge' });

    expect(calls.publishEnvelope).toHaveLength(1);
    expect(anchorCalls).toBe(1);
    expect(ledger.list()).toHaveLength(1);
  });

  it('reconciles an uncertain control anchor without broadcasting it twice', async () => {
    const { publishDeps, calls } = deps();
    const { store } = memoryJournal();
    publishDeps.manifestJournal = store;
    let controlCalls = 0;
    const payloadHex = `0x${'ef'.repeat(32)}` as const;
    publishDeps.anchorEnvelope = async (input) => {
      controlCalls += 1;
      input.onPrepared?.(payloadHex);
      input.onBroadcast?.(CONTROL_TX);
      throw Object.assign(new Error('control receipt unavailable'), {
        txHash: CONTROL_TX,
      });
    };
    publishDeps.reconcileAnchor = async (txHash) => ({
      status: 'confirmed',
      txHash,
      blockNumber: 10,
      gasUsed: 45_000n,
      feeWei: 90_000n,
    });
    const members = [
      { pending: await pending(1), instanceId: 'mono-1', sourceId: 'request-1' },
    ];

    await expect(
      publishManifestBatch(
        members,
        publishDeps,
        { batchKind: 'bridge', measurePerRecordControl: true },
      ),
    ).rejects.toBeInstanceOf(ManifestBatchRecordingError);
    await publishManifestBatch(
      members,
      publishDeps,
      { batchKind: 'bridge', measurePerRecordControl: true },
    );

    expect(controlCalls).toBe(1);
    expect(calls.controlRecords).toEqual([
      expect.objectContaining({ txHash: CONTROL_TX, payloadHex }),
    ]);
  });

  it('persists a control anchor intent before calling the external anchor', async () => {
    const { publishDeps, calls } = deps();
    const states = new Map<string, string>();
    publishDeps.manifestJournal = journalStore(
      states,
      (batchKey, stateJson) => {
        const state = JSON.parse(stateJson) as {
          partitions?: Array<{ controlTransaction?: { status?: string } }>;
        };
        if (state.partitions?.[0]?.controlTransaction?.status === 'intent') {
          throw new Error('control intent journal write failed');
        }
        states.set(batchKey, stateJson);
      },
    );

    const error = await publishManifestBatch(
      [{ pending: await pending(1), sourceId: 'request-1' }],
      publishDeps,
      { batchKind: 'bridge', measurePerRecordControl: true },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManifestBatchRecordingError);
    expect(error).toMatchObject({
      memberRefs: ['bafy-envelope-1'],
      batchKey: expect.any(String),
    });
    expect(String(error)).toContain('control intent journal write failed');
    expect(calls.anchorEnvelope).toHaveLength(0);
  });

  it('never re-broadcasts a control transaction when its callback hash save fails', async () => {
    const { publishDeps } = deps();
    const states = new Map<string, string>();
    let failBroadcastSave = true;
    publishDeps.manifestJournal = journalStore(
      states,
      (batchKey, stateJson) => {
        const state = JSON.parse(stateJson) as {
          partitions?: Array<{ controlTransaction?: { status?: string } }>;
        };
        if (
          failBroadcastSave &&
          state.partitions?.[0]?.controlTransaction?.status === 'broadcast'
        ) {
          failBroadcastSave = false;
          throw new Error('control hash journal write failed');
        }
        states.set(batchKey, stateJson);
      },
    );
    let controlCalls = 0;
    const payloadHex = `0x${'ef'.repeat(32)}` as const;
    publishDeps.anchorEnvelope = async (input) => {
      controlCalls += 1;
      input.onPrepared?.(payloadHex);
      input.onBroadcast?.(CONTROL_TX);
      return {
        txHash: CONTROL_TX,
        blockNumber: 10,
        gasUsed: 45_000n,
        feeWei: 90_000n,
        payloadHex,
      };
    };
    const members = [
      { pending: await pending(1), sourceId: 'request-1' },
    ];

    const first = await publishManifestBatch(
      members,
      publishDeps,
      { batchKind: 'bridge', measurePerRecordControl: true },
    ).catch((caught: unknown) => caught);
    const [batchKey] = states.keys();
    expect(first).toBeInstanceOf(ManifestBatchRecordingError);
    expect(first).toMatchObject({
      txHash: CONTROL_TX,
      memberRefs: ['bafy-envelope-1'],
      batchKey,
    });

    const resumed = await publishManifestBatch(
      members,
      publishDeps,
      { batchKind: 'bridge', measurePerRecordControl: true },
    ).catch((caught: unknown) => caught);
    expect(resumed).toBeInstanceOf(ManifestBatchRecordingError);
    expect(resumed).toMatchObject({
      txHash: null,
      memberRefs: ['bafy-envelope-1'],
      batchKey,
    });
    expect(String(resumed)).toMatch(/intent|reconcil|cannot safely retry/i);
    expect(controlCalls).toBe(1);
  });
});
