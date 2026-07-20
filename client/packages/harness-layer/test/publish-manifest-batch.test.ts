import { describe, expect, it, vi } from 'vitest';
import { ScrubPipeline } from '../../../src/trajectory/scrub/pipeline.js';
import { capture, type CapturedTask, type PendingEnvelope } from '../src/capture.js';
import {
  ManifestBatchAnchorError,
  publishManifestBatch,
  publishMemberEnvelope,
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
      calls.manifestBodies.push(parseManifestV0(body));
      return { cid: 'bafy-manifest', sha256: 'f'.repeat(64) };
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
      expect(verifyMember(member.cid, proof, result.root)).toBe(true);
    }

    expect(result).toMatchObject({
      manifestCid: 'bafy-manifest',
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
      manifestCid: 'bafy-manifest',
      contentKind: 'manifest',
      metadataKey: 'manifest:bafy-manifest',
      txHash: TEST_TX,
      gasUsed: 123_456n,
      feeWei: 987_648n,
    });
    expect(calls.logs).toEqual([
      expect.stringMatching(
        /^\[manifest] batch anchored cid=bafy-manifest members=3 gasUsed=123456 feeWei=987648$/,
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
    expect(result.control).toEqual({
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
    const { publishDeps } = deps();
    publishDeps.anchorManifest = async () => {
      throw Object.assign(new Error('receipt reverted'), { txHash: TEST_TX });
    };

    const error = await publishManifestBatch(
      [{ pending: await pending(1), polarity: 'pass', instanceId: 'mono-1' }],
      publishDeps,
      { batchKind: 'bridge' },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManifestBatchAnchorError);
    expect(error).toMatchObject({
      manifestCid: 'bafy-manifest',
      txHash: TEST_TX,
      memberRefs: ['bafy-envelope-1'],
    });
    expect(String(error)).toContain('receipt reverted');
  });
});
