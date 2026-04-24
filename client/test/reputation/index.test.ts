import { describe, it, expect, vi, afterEach } from 'vitest';
import { getOperatorReputation } from '../../src/reputation/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getOperatorReputation', () => {
  it('aggregates validation responses for the operator safe address', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          agents: [
            {
              id: '1',
              agentURI: 'envelope:bafy-1',
              owner: '0x1111111111111111111111111111111111111111',
              metadata: [
                { key: 'participant', value: '0x1111111111111111111111111111111111111111' },
                { key: 'role', value: 'restoration' },
                { key: 'evidenceTier', value: 'attested' },
              ],
            },
            {
              id: '2',
              agentURI: 'envelope:bafy-2',
              owner: '0x1111111111111111111111111111111111111111',
              metadata: [
                { key: 'participant', value: '0x1111111111111111111111111111111111111111' },
                { key: 'role', value: 'restoration' },
                { key: 'evidenceTier', value: 'self-signed' },
              ],
            },
          ],
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const reputation = await getOperatorReputation(
      '0x1111111111111111111111111111111111111111',
      { subgraphUrl: 'https://subgraph.test' },
    );

    expect(reputation.attestedPercent).toBeCloseTo(50, 1);
    expect(reputation.successfulVerifications).toBeDefined();
    expect(reputation.failedVerifications).toBeDefined();
    expect(reputation.lastSignalBlock).toBeDefined();
  });

  it('returns a zero-signal shape for an unknown operator', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { agents: [] } }),
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
});
