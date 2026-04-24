import { describe, it, expect, vi, afterEach } from 'vitest';
import { getOperatorReputation } from '../../src/reputation/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// Builds a mock V1 executionEnvelopes response body
function makeEnvelopesResponse(
  envelopes: Array<{
    id: string;
    agentURI: string;
    owner: string;
    role: string;
    evidenceTier: string;
    participant: string;
  }>,
) {
  return {
    data: {
      executionEnvelopes: envelopes.map(e => ({
        id: e.id,
        kind: 'portfolio.v0',
        role: e.role,
        evidenceTier: e.evidenceTier,
        participant: e.participant,
        generatedAt: '1700000000',
        createdAtBlock: '100',
        intent: { id: 'bafy-intent', kind: 'portfolio.v0' },
        parentEnvelope: null,
        agent: { id: e.id, agentURI: e.agentURI, owner: e.owner },
      })),
    },
  };
}

describe('getOperatorReputation', () => {
  it('aggregates validation responses for the operator safe address', async () => {
    const safeAddress = '0x1111111111111111111111111111111111111111';

    // queryEnvelopes call: returns two envelopes (1 attested, 1 self-signed)
    const envelopesBody = makeEnvelopesResponse([
      {
        id: '1',
        agentURI: 'envelope:bafy-1',
        owner: safeAddress,
        role: 'restoration',
        evidenceTier: 'attested',
        participant: safeAddress,
      },
      {
        id: '2',
        agentURI: 'envelope:bafy-2',
        owner: safeAddress,
        role: 'restoration',
        evidenceTier: 'self-signed',
        participant: safeAddress,
      },
    ]);

    // queryOperatorValidations call: no responses
    const validationsBody = { data: { validationResponses: [] } };

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => envelopesBody })
      .mockResolvedValueOnce({ ok: true, json: async () => validationsBody });
    vi.stubGlobal('fetch', fetchMock);

    const reputation = await getOperatorReputation(safeAddress, {
      subgraphUrl: 'https://subgraph.test',
    });

    expect(reputation.attestedPercent).toBeCloseTo(50, 1);
    expect(reputation.successfulVerifications).toBeDefined();
    expect(reputation.failedVerifications).toBeDefined();
    expect(reputation.lastSignalBlock).toBeDefined();
  });

  it('returns a zero-signal shape for an unknown operator', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { executionEnvelopes: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { validationResponses: [] } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const reputation = await getOperatorReputation(
      '0x9999999999999999999999999999999999999999',
      { subgraphUrl: 'https://subgraph.test' },
    );

    expect(reputation.successfulVerifications).toBe(0);
    expect(reputation.failedVerifications).toBe(0);
    expect(reputation.attestedPercent).toBe(0);
  });

  it('counts successful and failed verifications from validationResponses', async () => {
    const safeAddress = '0x2222222222222222222222222222222222222222';

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { executionEnvelopes: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            validationResponses: [
              { id: 'r1', overall: 'valid', createdAtBlock: '200', envelope: { id: 'bafy-env-1' } },
              { id: 'r2', overall: 'valid', createdAtBlock: '201', envelope: { id: 'bafy-env-2' } },
              { id: 'r3', overall: 'invalid', createdAtBlock: '202', envelope: { id: 'bafy-env-3' } },
            ],
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const reputation = await getOperatorReputation(safeAddress, {
      subgraphUrl: 'https://subgraph.test',
    });

    expect(reputation.successfulVerifications).toBe(2);
    expect(reputation.failedVerifications).toBe(1);
    expect(reputation.lastSignalBlock).toBe(202);
  });
});
