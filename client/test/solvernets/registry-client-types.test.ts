/**
 * Smoke test for the SolverNetRegistryClient interface (Task 3).
 *
 * Builds a no-op test double that satisfies the interface. The presence of
 * this file proves three things:
 *   1. The interface declaration in `registry-client.ts` is syntactically and
 *      type-system valid.
 *   2. A class can `implements SolverNetRegistryClient` with the five spec §13
 *      methods and TypeScript accepts the shape end-to-end.
 *   3. Supporting types (`SignerWithAgentEoa`, `SolverNetManifestSummary`)
 *      export and compose correctly.
 *
 * The day-1 concrete implementation ships in Task 4. This file does NOT
 * exercise IPFS, on-chain calls, or subgraph queries.
 */

import { describe, it, expect } from 'vitest';
import type { SolverNetManifestV1 } from '@jinn-network/sdk/solvernets';

import type {
  SolverNetRegistryClient,
  SolverNetManifestSummary,
  SignerWithAgentEoa,
} from '../../src/solvernets/registry-client.js';

// ── No-op test double ───────────────────────────────────────────────────────

class NoOpSolverNetRegistryClient implements SolverNetRegistryClient {
  async publishManifest(_args: {
    manifest: SolverNetManifestV1;
    signer: SignerWithAgentEoa;
  }): Promise<{
    manifestCid: string;
    metadataTxHash: `0x${string}`;
    metadataBlockNumber: number;
  }> {
    throw new Error('not implemented');
  }

  async publishLifecycleTransition(_args: {
    manifestCid: string;
    launcherAgentId: string;
    target: 'launched' | 'paused' | 'retired';
    signer: SignerWithAgentEoa;
  }): Promise<{
    metadataTxHash: `0x${string}`;
    metadataBlockNumber: number;
  }> {
    throw new Error('not implemented');
  }

  async listLaunched(_args: {
    network: string;
    statusFilter?: Array<'launched' | 'paused' | 'retired'>;
    sinceBlock?: number;
  }): Promise<{ summaries: SolverNetManifestSummary[]; failedCount: number }> {
    return { summaries: [], failedCount: 0 };
  }

  async getManifest(_args: { manifestCid: string }): Promise<SolverNetManifestV1> {
    throw new Error('not implemented');
  }

  async getManifestFromCache(_args: {
    manifestCid: string;
  }): Promise<SolverNetManifestV1 | null> {
    return null;
  }

  async getLifecycleStatus(_args: { manifestCid: string }): Promise<{
    status: 'launched' | 'paused' | 'retired';
    statusUpdatedAt: string;
    sourceBlock: number;
  }> {
    throw new Error('not implemented');
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SolverNetRegistryClient interface', () => {
  it('a no-op implementation satisfies the five-method shape from spec §13', () => {
    const client: SolverNetRegistryClient = new NoOpSolverNetRegistryClient();

    expect(typeof client.publishManifest).toBe('function');
    expect(typeof client.publishLifecycleTransition).toBe('function');
    expect(typeof client.listLaunched).toBe('function');
    expect(typeof client.getManifest).toBe('function');
    expect(typeof client.getManifestFromCache).toBe('function');
    expect(typeof client.getLifecycleStatus).toBe('function');
  });

  it('listLaunched is callable and returns { summaries, failedCount }', async () => {
    const client: SolverNetRegistryClient = new NoOpSolverNetRegistryClient();
    const result = await client.listLaunched({ network: 'base-sepolia' });
    expect(Array.isArray(result.summaries)).toBe(true);
    expect(result.summaries).toHaveLength(0);
    expect(result.failedCount).toBe(0);
  });

  it('SignerWithAgentEoa accepts the documented data-only shape', () => {
    const signer: SignerWithAgentEoa = {
      agentEoaAddress: '0x0000000000000000000000000000000000000001',
      agentEoaPrivateKey:
        '0x0000000000000000000000000000000000000000000000000000000000000001',
      agentId: 'agent-1',
    };
    expect(signer.agentEoaAddress).toMatch(/^0x[0-9a-fA-F]+$/u);
    expect(signer.agentEoaPrivateKey).toMatch(/^0x[0-9a-fA-F]+$/u);
    expect(signer.agentId).toBe('agent-1');
  });

  it('SolverNetManifestSummary accepts the catalog-row shape', () => {
    const summary: SolverNetManifestSummary = {
      manifestCid: 'bafy...',
      solverNetId: 'launcher-1/prediction-001',
      name: 'Prediction v1',
      network: 'base-sepolia',
      launcherAgentId: 'agent-1',
      launcherSafeAddress: '0x0000000000000000000000000000000000000002',
      status: 'launched',
      statusUpdatedAt: '2026-05-06T00:00:00.000Z',
      contractId: 'prediction',
      contractVersion: 'v1',
      solutionPriceWei: '1000000000000000',
      verdictPriceWei: '500000000000000',
      openRoles: ['solver', 'evaluator'],
      anchorBlock: 42,
    };
    expect(summary.status).toBe('launched');
    expect(summary.openRoles).toEqual(['solver', 'evaluator']);
  });
});
