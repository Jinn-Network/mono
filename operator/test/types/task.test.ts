import { describe, it, expect } from 'vitest';
import { parseTask } from '../../src/types/task.js';

const DEFAULT_CLAIM_POLICY = {
  mode: 'parallel' as const,
  maxClaims: 25,
  maxClaimsPerOperator: 1,
  claimLeaseTtlSeconds: 600,
};

describe('Task', () => {
  it('parses a valid Task', () => {
    const input = {
      description: 'The API should return 200 on /health',
      context: { endpoint: 'https://api.example.com/health' },
    };
    const result = parseTask(input);
    expect(result.description).toBe(input.description);
    expect(result.context).toEqual(input.context);
    expect(result.id).toBeDefined();
  });

  it('rejects a Task without description', () => {
    expect(() => parseTask({ context: {} })).toThrow();
  });
});

describe('parseTask signedTask hydration', () => {
  it('hydrates loose fields from signedTask when loose fields are absent', () => {
    const signedTask = {
      schemaVersion: 'task.v1' as const,
      id: 'abc',
      solverType: 'portfolio.v0',
      contractId: 'portfolio',
      contractVersion: 'v0',
      solverNetManifestCid: 'bafyfixturecid',
      role: 'restoration' as const,
      description: 'trade',
      window: { startTs: 1, endTs: 86400001 },
      spec: {},
      eligibility: {},
      claimPolicy: DEFAULT_CLAIM_POLICY,
      creator: { safeAddress: '0xaaa', agentEoa: '0xbbb' },
      createdAt: 1,
      signature: {
        algo: 'secp256k1' as const,
        signer: '0xbbb',
        hash: '0x' + 'ab'.repeat(32),
        sig: '0x' + 'cd'.repeat(65),
      },
    };

    const parsed = parseTask({ signedTask });
    expect(parsed.description).toBe('trade');
    expect(parsed.window).toEqual({ startTs: 1, endTs: 86400001 });
    expect(parsed.solverType).toBe('portfolio.v0');
    expect(parsed.contractId).toBe('portfolio');
    expect(parsed.contractVersion).toBe('v0');
    expect(parsed.solverNetManifestCid).toBe('bafyfixturecid');
    expect(parsed.spec).toEqual({});
    expect(parsed.signedTask).toBeDefined();
  });

  it('loose fields override signedTask fields when both are present', () => {
    const signedTask = {
      schemaVersion: 'task.v1' as const,
      id: 'abc',
      solverType: 'portfolio.v0',
      contractId: 'portfolio',
      contractVersion: 'v0',
      solverNetManifestCid: 'bafyfixturecid',
      role: 'restoration' as const,
      description: 'from-task',
      window: { startTs: 1, endTs: 86400001 },
      spec: {},
      eligibility: {},
      claimPolicy: DEFAULT_CLAIM_POLICY,
      creator: { safeAddress: '0xaaa', agentEoa: '0xbbb' },
      createdAt: 1,
      signature: {
        algo: 'secp256k1' as const,
        signer: '0xbbb',
        hash: '0x' + 'ab'.repeat(32),
        sig: '0x' + 'cd'.repeat(65),
      },
    };

    const parsed = parseTask({
      description: 'loose-wins',
      signedTask,
    });
    expect(parsed.description).toBe('loose-wins');
  });
});
