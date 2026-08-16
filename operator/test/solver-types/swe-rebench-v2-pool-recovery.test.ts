/**
 * Tests for recoverVettedPoolFromNetwork (#957).
 *
 * A freshly-deployed operator has an empty disk: no validated-pool.json, so the
 * generator hits admission-required-no-data and posts 0 tasks. The pool was
 * previously published to IPFS; we recover it via the indexer (Option B):
 *
 *   1. getMostRecentTaskCidDigest(manifestCid) → a recent task digest
 *   2. reconstruct the IPFS task CID (f01551220 + digest), fetch the task doc
 *   3. read the vetted-pool ref from the task's eligibility.vettedPoolRef
 *   4. fetch the artifact, verify hashVettedPoolArtifact === ref.artifactHash
 *   5. write validated-pool.json (never overwriting a newer/existing local pool)
 *
 * SECURITY: a hash mismatch MUST NOT write any file. Recovery NEVER throws.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recoverVettedPoolFromNetwork,
  isTerminalRecoveryOutcome,
} from '../../src/solver-types/_swe-rebench-v2-pool-recovery.js';
import {
  ValidatedPoolStore,
  EVAL_SEMANTICS_VERSION,
  createVettedPoolArtifactRef,
  exportScorableVettedPoolArtifact,
  hashVettedPoolArtifact,
  type SweRebenchV2VettedPoolArtifact,
} from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';

const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'swe-pool-recovery-test-'));
  tmps.push(d);
  return d;
}
function cleanup(): void {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
}

const MANIFEST_CID = 'bafyManifestRecovery';
const TASK_CID_DIGEST = `0x${'ab'.repeat(32)}` as `0x${string}`;
const ARTIFACT_CID = 'bafyArtifactRecovery';

/** Build a valid scorable artifact (two instances) and its matching ref. */
async function buildArtifactAndRef(): Promise<{
  artifact: SweRebenchV2VettedPoolArtifact;
  artifactHash: `sha256:${string}`;
}> {
  const dir = tmpDir();
  const store = new ValidatedPoolStore({ stateDir: dir });
  await store.record(
    'org__repo-1',
    { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-14T00:00:01Z' },
    EVAL_SEMANTICS_VERSION,
  );
  await store.record(
    'org__repo-2',
    { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-14T00:00:02Z' },
    EVAL_SEMANTICS_VERSION,
  );
  const artifact = await exportScorableVettedPoolArtifact(store, EVAL_SEMANTICS_VERSION, {
    generatedAt: '2026-06-01T00:00:00.000Z',
  });
  if (!artifact) throw new Error('failed to build fixture artifact');
  return { artifact, artifactHash: hashVettedPoolArtifact(artifact) };
}

/** Recent-task lookup stub (Wave-4 D4 retired DiscoveryAPI). */
function digestStub(
  result: { taskCidDigest: `0x${string}`; taskId: string } | undefined,
): (manifestCid: string) => Promise<{ taskCidDigest: `0x${string}`; taskId: string } | null> {
  return async () => result ?? null;
}

/**
 * A fetchFromIpfs stub. First call (the task CID) returns the task doc carrying
 * `eligibility.vettedPoolRef`; the second call (the artifact CID) returns the
 * artifact (optionally tampered to break the hash).
 */
function ipfsStub(opts: {
  ref: unknown;
  artifact: unknown;
  failTaskFetch?: boolean;
}): (gatewayUrl: string, cid: string) => Promise<unknown> {
  return async (_gatewayUrl: string, cid: string) => {
    if (opts.failTaskFetch) throw new Error('IPFS fetch failed (simulated)');
    if (cid === ARTIFACT_CID) return opts.artifact;
    // task CID
    return { schemaVersion: 'task.v1', eligibility: { vettedPoolRef: opts.ref } };
  };
}

describe('recoverVettedPoolFromNetwork (#957)', () => {
  it('happy path: empty stateDir → fetches, hash matches, writes validated-pool.json', async () => {
    const stateDir = tmpDir();
    const { artifact, artifactHash } = await buildArtifactAndRef();
    const ref = createVettedPoolArtifactRef({
      manifestCid: MANIFEST_CID,
      artifactCid: ARTIFACT_CID,
      artifactHash,
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      publishedAt: '2026-06-01T00:00:00.000Z',
    });
    const store = new ValidatedPoolStore({ stateDir });

    const result = await recoverVettedPoolFromNetwork({
      stateDir,
      manifestCid: MANIFEST_CID,
      getMostRecentTaskCidDigest: digestStub({ taskCidDigest: TASK_CID_DIGEST, taskId: '5' }),
      ipfsGatewayUrl: 'https://gateway.example',
      store,
      fetchFromIpfs: ipfsStub({ ref, artifact }),
    });

    expect(result.recovered).toBe(true);
    expect(existsSync(join(stateDir, 'validated-pool.json'))).toBe(true);
    // The recovered scorable set is readable through the store.
    const ids = await store.getScorableIds(EVAL_SEMANTICS_VERSION);
    expect(ids).toEqual(new Set(['org__repo-1', 'org__repo-2']));
    cleanup();
  });

  it('SECURITY: hash mismatch → recovered:false, no file written', async () => {
    const stateDir = tmpDir();
    const { artifact, artifactHash } = await buildArtifactAndRef();
    const ref = createVettedPoolArtifactRef({
      manifestCid: MANIFEST_CID,
      artifactCid: ARTIFACT_CID,
      artifactHash,
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      publishedAt: '2026-06-01T00:00:00.000Z',
    });
    // Tamper the artifact AFTER the ref was built → hashVettedPoolArtifact(tampered) !== ref.artifactHash.
    const tampered: SweRebenchV2VettedPoolArtifact = {
      ...artifact,
      entries: [
        { instance_id: 'org__EVIL-injected', scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-06-01T00:00:00Z' },
      ],
    };
    const store = new ValidatedPoolStore({ stateDir });

    const result = await recoverVettedPoolFromNetwork({
      stateDir,
      manifestCid: MANIFEST_CID,
      getMostRecentTaskCidDigest: digestStub({ taskCidDigest: TASK_CID_DIGEST, taskId: '5' }),
      ipfsGatewayUrl: 'https://gateway.example',
      store,
      fetchFromIpfs: ipfsStub({ ref, artifact: tampered }),
    });

    expect(result.recovered).toBe(false);
    expect(result.reason).toBe('hash-mismatch');
    expect(existsSync(join(stateDir, 'validated-pool.json'))).toBe(false);
    cleanup();
  });

  it('no task: discovery returns undefined → recovered:false, no throw, no file', async () => {
    const stateDir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir });

    const result = await recoverVettedPoolFromNetwork({
      stateDir,
      manifestCid: MANIFEST_CID,
      getMostRecentTaskCidDigest: digestStub(undefined),
      ipfsGatewayUrl: 'https://gateway.example',
      store,
      fetchFromIpfs: async () => {
        throw new Error('should not fetch when there is no task');
      },
    });

    expect(result).toEqual({ recovered: false, reason: 'no-task' });
    expect(existsSync(join(stateDir, 'validated-pool.json'))).toBe(false);
    cleanup();
  });

  it('never-overwrite: an existing local pool is not clobbered', async () => {
    const stateDir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir });
    // A local validated pool already exists (operator already validated locally).
    await store.record(
      'local__existing',
      { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-06-02T00:00:00Z' },
      EVAL_SEMANTICS_VERSION,
    );

    const { artifact, artifactHash } = await buildArtifactAndRef();
    const ref = createVettedPoolArtifactRef({
      manifestCid: MANIFEST_CID,
      artifactCid: ARTIFACT_CID,
      artifactHash,
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      publishedAt: '2026-06-01T00:00:00.000Z',
    });

    const result = await recoverVettedPoolFromNetwork({
      stateDir,
      manifestCid: MANIFEST_CID,
      getMostRecentTaskCidDigest: digestStub({ taskCidDigest: TASK_CID_DIGEST, taskId: '5' }),
      ipfsGatewayUrl: 'https://gateway.example',
      store,
      fetchFromIpfs: ipfsStub({ ref, artifact }),
    });

    expect(result.recovered).toBe(false);
    expect(result.reason).toBe('local-pool-present');
    // The local pool is intact and was NOT replaced by the network artifact.
    const ids = await store.getScorableIds(EVAL_SEMANTICS_VERSION);
    expect(ids).toEqual(new Set(['local__existing']));
    cleanup();
  });

  it('never-throw: fetchFromIpfs rejects → structured recovered:false, no throw', async () => {
    const stateDir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir });

    const result = await recoverVettedPoolFromNetwork({
      stateDir,
      manifestCid: MANIFEST_CID,
      getMostRecentTaskCidDigest: digestStub({ taskCidDigest: TASK_CID_DIGEST, taskId: '5' }),
      ipfsGatewayUrl: 'https://gateway.example',
      store,
      fetchFromIpfs: ipfsStub({ ref: null, artifact: null, failTaskFetch: true }),
    });

    expect(result.recovered).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(existsSync(join(stateDir, 'validated-pool.json'))).toBe(false);
    cleanup();
  });

  it('no-ref: task doc has no vettedPoolRef → recovered:false, no file', async () => {
    const stateDir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir });

    const result = await recoverVettedPoolFromNetwork({
      stateDir,
      manifestCid: MANIFEST_CID,
      getMostRecentTaskCidDigest: digestStub({ taskCidDigest: TASK_CID_DIGEST, taskId: '5' }),
      ipfsGatewayUrl: 'https://gateway.example',
      store,
      // task doc carries no eligibility.vettedPoolRef.
      fetchFromIpfs: async () => ({ schemaVersion: 'task.v1', eligibility: {} }),
    });

    expect(result.recovered).toBe(false);
    expect(result.reason).toBe('no-ref');
    expect(existsSync(join(stateDir, 'validated-pool.json'))).toBe(false);
    cleanup();
  });
});

describe('isTerminalRecoveryOutcome (#957 latch decision)', () => {
  // TERMINAL — latch permanently, never retry: retrying cannot change the result.
  it('treats a successful recovery as terminal', () => {
    expect(isTerminalRecoveryOutcome({ recovered: true, entriesRecovered: 3 })).toBe(true);
  });
  it('treats local-pool-present as terminal', () => {
    expect(isTerminalRecoveryOutcome({ recovered: false, reason: 'local-pool-present' })).toBe(true);
  });

  // TRANSIENT — do NOT latch; the caller retries under a bounded cap.
  it('treats hash-mismatch as transient (bad artifact is rejected at write time; a corrupted gateway response or a re-published corrected ref can recover on a later attempt — the bounded cap stops looping on a genuinely-bad ref)', () => {
    expect(isTerminalRecoveryOutcome({ recovered: false, reason: 'hash-mismatch' })).toBe(false);
  });
  it('treats no-task as transient (fresh SolverNet may post its first task later)', () => {
    expect(isTerminalRecoveryOutcome({ recovered: false, reason: 'no-task' })).toBe(false);
  });
  it('treats no-ref as transient', () => {
    expect(isTerminalRecoveryOutcome({ recovered: false, reason: 'no-ref' })).toBe(false);
  });
  it('treats error:* as transient (indexer / IPFS blip)', () => {
    expect(isTerminalRecoveryOutcome({ recovered: false, reason: 'error:gateway timeout' })).toBe(false);
  });
});
