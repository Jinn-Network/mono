import { describe, it, expect, vi } from 'vitest';
import { createVerdictSource } from '../src/bridge-verdict-source.js';
import { bridgeAttempts, type BridgeEvidence } from '../src/bridge.js';

const GQL_URL = 'https://indexer.example/graphql';

interface VerdictItem {
  requestId: string;
  chainId: number;
  instanceId: string;
  actualPassed: boolean;
  evaluatorVerdict: string;
  manifestCid: string;
}

/**
 * Build a `fetchImpl` mock that answers the single `BridgeVerdicts` leg with the
 * canned verdict rows. Single unpaged page.
 */
function mockFetch(verdicts: VerdictItem[]): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query: string };
    const noNext = { hasNextPage: false, endCursor: null };
    if (!body.query.includes('BridgeVerdicts')) {
      throw new Error(`unexpected query: ${body.query.slice(0, 40)}`);
    }
    const data = { verdictEnvelopeMetas: { items: verdicts, pageInfo: noNext } };
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const RID = (n: number): string => '0x' + String(n).repeat(64).slice(0, 64);

describe('createVerdictSource', () => {
  it('returns pass + fail refs carrying verdictManifestCid, drops INVALID', async () => {
    const verdicts: VerdictItem[] = [
      // A verified pass → polarity 'pass'.
      { requestId: RID(1), chainId: 84532, instanceId: 'django__django-11333', actualPassed: true, evaluatorVerdict: 'PASS', manifestCid: 'bafyVerdictPass' },
      // An evaluator-confirmed failure → polarity 'fail'.
      { requestId: RID(2), chainId: 84532, instanceId: 'sympy__sympy-27510', actualPassed: false, evaluatorVerdict: 'FAIL', manifestCid: 'bafyVerdictFail' },
      // INVALID → must be dropped (noise, not a lesson).
      { requestId: RID(3), chainId: 84532, instanceId: 'flask__flask-4200', actualPassed: false, evaluatorVerdict: 'INVALID', manifestCid: 'bafyVerdictInvalid' },
    ];

    const source = createVerdictSource({ graphqlUrl: GQL_URL, fetchImpl: mockFetch(verdicts) });
    const refs = await source.list();

    expect(refs).toHaveLength(2);

    const pass = refs.find((r) => r.requestId === RID(1));
    expect(pass).toEqual({
      requestId: RID(1),
      chainId: 84532,
      instanceId: 'django__django-11333',
      model: '',
      manifestCid: '',
      polarity: 'pass',
      verdictManifestCid: 'bafyVerdictPass',
      discoveryCandidates: [
        {
          instanceId: 'django__django-11333',
          verdictManifestCid: 'bafyVerdictPass',
        },
      ],
    });

    const fail = refs.find((r) => r.requestId === RID(2));
    expect(fail).toEqual({
      requestId: RID(2),
      chainId: 84532,
      instanceId: 'sympy__sympy-27510',
      model: '',
      manifestCid: '',
      polarity: 'fail',
      verdictManifestCid: 'bafyVerdictFail',
      discoveryCandidates: [
        {
          instanceId: 'sympy__sympy-27510',
          verdictManifestCid: 'bafyVerdictFail',
        },
      ],
    });

    // The INVALID row is dropped entirely.
    expect(refs.some((r) => r.requestId === RID(3))).toBe(false);
  });

  it('drops INDETERMINATE / UNKNOWN and rows where actualPassed disagrees with the verdict', async () => {
    const verdicts: VerdictItem[] = [
      { requestId: RID(4), chainId: 84532, instanceId: 'a__a-1', actualPassed: false, evaluatorVerdict: 'INDETERMINATE', manifestCid: 'x' },
      { requestId: RID(5), chainId: 84532, instanceId: 'b__b-2', actualPassed: true, evaluatorVerdict: 'UNKNOWN', manifestCid: 'y' },
      // Disagreement: actualPassed true but evaluatorVerdict FAIL — not a clean polarity.
      { requestId: RID(6), chainId: 84532, instanceId: 'c__c-3', actualPassed: true, evaluatorVerdict: 'FAIL', manifestCid: 'z' },
    ];
    const source = createVerdictSource({ graphqlUrl: GQL_URL, fetchImpl: mockFetch(verdicts) });
    expect(await source.list()).toEqual([]);
  });

  it('drops a verdict with no manifestCid (no join entry point → nothing to bridge)', async () => {
    const verdicts: VerdictItem[] = [
      { requestId: RID(7), chainId: 84532, instanceId: 'd__d-4', actualPassed: true, evaluatorVerdict: 'PASS', manifestCid: '' },
    ];
    const source = createVerdictSource({ graphqlUrl: GQL_URL, fetchImpl: mockFetch(verdicts) });
    expect(await source.list()).toEqual([]);
  });

  it('retains bounded identity candidates on one discovery ref per request, chain, and polarity', async () => {
    const verdicts: VerdictItem[] = [
      {
        requestId: RID(8),
        chainId: 84532,
        instanceId: 'd__d-8',
        actualPassed: true,
        evaluatorVerdict: 'PASS',
        manifestCid: 'bafyNewestUntrustedCandidate',
      },
      {
        requestId: RID(8),
        chainId: 84532,
        instanceId: 'd__d-8',
        actualPassed: true,
        evaluatorVerdict: 'PASS',
        manifestCid: 'bafyOlderAuthenticatedCandidate',
      },
      {
        requestId: RID(8),
        chainId: 84532,
        instanceId: 'd__d-8',
        actualPassed: false,
        evaluatorVerdict: 'FAIL',
        manifestCid: 'bafyFailureCandidate',
      },
    ];
    const source = createVerdictSource({
      graphqlUrl: GQL_URL,
      fetchImpl: mockFetch(verdicts),
    });

    await expect(source.list()).resolves.toEqual([
      expect.objectContaining({
        requestId: RID(8),
        polarity: 'pass',
        verdictManifestCid: 'bafyNewestUntrustedCandidate',
        discoveryCandidates: [
          {
            instanceId: 'd__d-8',
            verdictManifestCid: 'bafyNewestUntrustedCandidate',
          },
          {
            instanceId: 'd__d-8',
            verdictManifestCid: 'bafyOlderAuthenticatedCandidate',
          },
        ],
      }),
      expect.objectContaining({
        requestId: RID(8),
        polarity: 'fail',
        verdictManifestCid: 'bafyFailureCandidate',
        discoveryCandidates: [
          {
            instanceId: 'd__d-8',
            verdictManifestCid: 'bafyFailureCandidate',
          },
        ],
      }),
    ]);
  });

  it('does not let an attacker-first projected instance suppress genuine evidence end to end', async () => {
    const attackerInstance = 'django__django-99999';
    const genuineInstance = 'flask__flask-4200';
    const source = createVerdictSource({
      graphqlUrl: GQL_URL,
      fetchImpl: mockFetch([
        {
          requestId: RID(9),
          chainId: 84532,
          instanceId: attackerInstance,
          actualPassed: true,
          evaluatorVerdict: 'PASS',
          manifestCid: 'bafyAttacker',
        },
        {
          requestId: RID(9),
          chainId: 84532,
          instanceId: genuineInstance,
          actualPassed: true,
          evaluatorVerdict: 'PASS',
          manifestCid: 'bafyGenuine',
        },
      ]),
    });
    const refs = await source.list({ limit: 1 });
    const attemptedInstances: string[] = [];
    const publishedInstances: string[] = [];
    const genuineEvidence: BridgeEvidence = {
      taskSummary: 'Fix the authenticated Flask task',
      patch: 'diff --git a/flask/app.py b/flask/app.py',
      instanceId: genuineInstance,
      repo: 'flask/flask',
      baseCommit: 'a'.repeat(40),
      taskCreatedAt: 1_752_000_000,
      verifier: {
        failToPass: ['tests/test_regression.py::test_fix'],
        passToPass: ['tests/test_existing.py::test_ok'],
        evalSemanticsVersion: '4',
      },
    };

    const result = await bridgeAttempts(refs, {
      slateInstanceIds: new Set([attackerInstance]),
      fetchEvidence: async (candidate) => {
        attemptedInstances.push(candidate.instanceId);
        if (candidate.instanceId !== genuineInstance) {
          throw new Error('projected instance does not match signed task');
        }
        return genuineEvidence;
      },
      publishEvidence: async (task, candidate) => {
        publishedInstances.push(candidate.instanceId);
        expect(task.task.instanceId).toBe(genuineInstance);
        return { envelopeRef: 'bafyEpisode', anchorTx: null };
      },
    });

    expect(attemptedInstances).toEqual([attackerInstance, genuineInstance]);
    expect(publishedInstances).toEqual([genuineInstance]);
    expect(result.bridged).toEqual([
      {
        instanceId: genuineInstance,
        polarity: 'pass',
        envelopeRef: 'bafyEpisode',
        anchorTx: null,
      },
    ]);
    expect(result.excludedHeldOut).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('bounds retained identity projections without spending the attempt limit on collisions', async () => {
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      requestId: RID(1),
      chainId: 84532,
      instanceId: `attacker__projection-${index}`,
      actualPassed: true,
      evaluatorVerdict: 'PASS',
      manifestCid: `bafyCandidate${index}`,
    }));
    const source = createVerdictSource({
      graphqlUrl: GQL_URL,
      fetchImpl: mockFetch([
        ...candidates,
        {
          requestId: RID(2),
          chainId: 84532,
          instanceId: 'flask__flask-4200',
          actualPassed: true,
          evaluatorVerdict: 'PASS',
          manifestCid: 'bafySecondAttempt',
        },
      ]),
    });

    const refs = await source.list({ limit: 2 });

    expect(refs).toHaveLength(2);
    expect(refs[0]?.discoveryCandidates).toHaveLength(32);
    expect(refs[1]).toEqual(expect.objectContaining({
      requestId: RID(2),
      instanceId: 'flask__flask-4200',
    }));
  });

  it('appends /graphql to a bare base URL', async () => {
    const fetchImpl = mockFetch([]);
    const source = createVerdictSource({ graphqlUrl: 'https://indexer.example', fetchImpl });
    await source.list();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://indexer.example/graphql',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws on a non-ok HTTP response', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 503, statusText: 'Service Unavailable' })) as unknown as typeof fetch;
    const source = createVerdictSource({ graphqlUrl: GQL_URL, fetchImpl });
    await expect(source.list()).rejects.toThrow(/HTTP 503/);
  });

  it('throws on a GraphQL errors payload', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: 'bad field' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const source = createVerdictSource({ graphqlUrl: GQL_URL, fetchImpl });
    await expect(source.list()).rejects.toThrow(/bad field/);
  });
});
