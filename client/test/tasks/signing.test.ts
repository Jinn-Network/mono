import { describe, it, expect } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { signTaskV1 } from '../../src/tasks/signing.js';
import { parseSignedTaskV1, type TaskV1 } from '../../src/types/task-document.js';

const DEFAULT_CLAIM_POLICY = {
  mode: 'parallel' as const,
  maxClaims: 25,
  maxClaimsPerOperator: 1,
  claimLeaseTtlSeconds: 600,
};

describe('signTaskV1', () => {
  it('produces a SignedTaskV1 that round-trips through parseSignedTaskV1', async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const task: TaskV1 = {
      schemaVersion: 'task.v1',
      id: '550e8400-e29b-41d4-a716-446655440000',
      solverType: 'portfolio.v0',
      contractId: 'portfolio',
      contractVersion: 'v0',
      solverNetManifestCid: 'bafyfixturecid',
      role: 'restoration',
      description: 'trade',
      window: { startTs: 1, endTs: 86400001 },
      spec: {},
      eligibility: {},
      claimPolicy: DEFAULT_CLAIM_POLICY,
      creator: {
        safeAddress: '0x3333333333333333333333333333333333333333',
        agentEoa: account.address,
      },
      createdAt: 1700000000000,
    };

    const signed = await signTaskV1(task, pk);

    expect(signed.signature.algo).toBe('secp256k1');
    expect(signed.signature.signer.toLowerCase()).toBe(account.address.toLowerCase());
    expect(signed.signature.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signed.signature.sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(() => parseSignedTaskV1(signed)).not.toThrow();
  });

  it('is deterministic for the same input', async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const task: TaskV1 = {
      schemaVersion: 'task.v1',
      id: 'abc',
      solverType: 'portfolio.v0',
      contractId: 'portfolio',
      contractVersion: 'v0',
      solverNetManifestCid: 'bafyfixturecid',
      role: 'restoration',
      description: 'trade',
      window: { startTs: 1, endTs: 86400001 },
      spec: {},
      eligibility: {},
      claimPolicy: DEFAULT_CLAIM_POLICY,
      creator: {
        safeAddress: '0x3333333333333333333333333333333333333333',
        agentEoa: account.address,
      },
      createdAt: 1700000000000,
    };

    const s1 = await signTaskV1(task, pk);
    const s2 = await signTaskV1(task, pk);
    expect(s1.signature.hash).toBe(s2.signature.hash);
    expect(s1.signature.sig).toBe(s2.signature.sig);
  });

  it('produces hash = keccak256(JCS(task without signature))', async () => {
    const { keccak256, toBytes } = await import('viem');
    const { canonicalJson } = await import('../../src/harnesses/engine/canonical-json.js');

    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const task: TaskV1 = {
      schemaVersion: 'task.v1',
      id: 'xyz',
      solverType: 'portfolio.v0',
      contractId: 'portfolio',
      contractVersion: 'v0',
      solverNetManifestCid: 'bafyfixturecid',
      role: 'restoration',
      description: 'x',
      window: { startTs: 1, endTs: 86400001 },
      spec: {},
      eligibility: {},
      claimPolicy: DEFAULT_CLAIM_POLICY,
      creator: {
        safeAddress: '0x3333333333333333333333333333333333333333',
        agentEoa: account.address,
      },
      createdAt: 1,
    };

    const expectedHash = keccak256(toBytes(canonicalJson(task)));

    const signed = await signTaskV1(task, pk);
    expect(signed.signature.hash).toBe(expectedHash);
  });

  it('changing any executionRequest field changes the signed hash (issue #2039 AC1)', async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const baseTask: TaskV1 = {
      schemaVersion: 'task.v1',
      id: 'exec-request-signing',
      solverType: 'portfolio.v0',
      contractId: 'portfolio',
      contractVersion: 'v0',
      solverNetManifestCid: 'bafyfixturecid',
      role: 'restoration',
      description: 'trade',
      window: { startTs: 1, endTs: 86400001 },
      spec: {},
      eligibility: {},
      claimPolicy: DEFAULT_CLAIM_POLICY,
      creator: {
        safeAddress: '0x3333333333333333333333333333333333333333',
        agentEoa: account.address,
      },
      createdAt: 1700000000000,
      executionRequest: {
        harness: 'codex',
        model: 'gpt-5-codex',
        version: '1.2.3',
        loadoutRef: 'arm-a',
        isolation: 'dedicated',
      },
    };

    const signedOriginal = await signTaskV1(baseTask, pk);
    const signedChangedHarness = await signTaskV1(
      { ...baseTask, executionRequest: { ...baseTask.executionRequest!, harness: 'claude-code' } },
      pk,
    );
    const signedChangedModel = await signTaskV1(
      { ...baseTask, executionRequest: { ...baseTask.executionRequest!, model: 'gpt-5.1' } },
      pk,
    );
    const signedChangedVersion = await signTaskV1(
      { ...baseTask, executionRequest: { ...baseTask.executionRequest!, version: '2.0.0' } },
      pk,
    );
    const signedChangedLoadoutRef = await signTaskV1(
      { ...baseTask, executionRequest: { ...baseTask.executionRequest!, loadoutRef: 'arm-b' } },
      pk,
    );
    const signedChangedIsolation = await signTaskV1(
      { ...baseTask, executionRequest: { ...baseTask.executionRequest!, isolation: 'shared' } },
      pk,
    );
    const signedNoExecutionRequest = await signTaskV1(
      (() => {
        const { executionRequest: _drop, ...rest } = baseTask;
        return rest as TaskV1;
      })(),
      pk,
    );

    // A signature carried over from the original document no longer matches
    // the (hash, sig) any of these mutated documents produce — the whole
    // canonical document is hashed, so pinning-field tampering is detected
    // the same way any other field tampering is.
    expect(signedChangedHarness.signature.hash).not.toBe(signedOriginal.signature.hash);
    expect(signedChangedModel.signature.hash).not.toBe(signedOriginal.signature.hash);
    expect(signedChangedVersion.signature.hash).not.toBe(signedOriginal.signature.hash);
    expect(signedChangedLoadoutRef.signature.hash).not.toBe(signedOriginal.signature.hash);
    expect(signedChangedIsolation.signature.hash).not.toBe(signedOriginal.signature.hash);
    expect(signedNoExecutionRequest.signature.hash).not.toBe(signedOriginal.signature.hash);
  });
});
