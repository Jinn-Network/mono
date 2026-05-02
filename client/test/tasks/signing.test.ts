import { describe, it, expect } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { signTaskV1 } from '../../src/tasks/signing.js';
import { parseSignedTaskV1, type TaskV1 } from '../../src/types/task-document.js';

describe('signTaskV1', () => {
  it('produces a SignedTaskV1 that round-trips through parseSignedTaskV1', async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const task: TaskV1 = {
      schemaVersion: 'task.v1',
      id: '550e8400-e29b-41d4-a716-446655440000',
      solverType: 'portfolio.v0',
      role: 'restoration',
      description: 'trade',
      window: { startTs: 1, endTs: 86400001 },
      spec: {},
      eligibility: {},
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
      role: 'restoration',
      description: 'trade',
      window: { startTs: 1, endTs: 86400001 },
      spec: {},
      eligibility: {},
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
      role: 'restoration',
      description: 'x',
      window: { startTs: 1, endTs: 86400001 },
      spec: {},
      eligibility: {},
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
});
