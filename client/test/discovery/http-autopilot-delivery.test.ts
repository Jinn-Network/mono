import { describe, expect, it, vi } from 'vitest';

import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';

const INDEXER_URL = 'https://indexer.example';
const CHAIN_ID = 84532;
const TASK_ID = '501';
const REQUEST_ID = `0x${'11'.repeat(32)}` as const;
const VERDICT_REQUEST_ID = `0x${'12'.repeat(32)}` as const;
const OPERATOR = `0x${'22'.repeat(20)}` as const;
const EVALUATOR = `0x${'23'.repeat(20)}` as const;
const TASK_CID_DIGEST = `0x${'33'.repeat(32)}` as const;
const TASK_CREATED_TX = `0x${'44'.repeat(32)}` as const;
const ENVELOPE_CID = `f01551220${'55'.repeat(32)}`;
const MANIFEST_HASH = `0x${'66'.repeat(32)}` as const;

const task = {
  id: TASK_ID,
  chainId: CHAIN_ID,
  taskCidDigest: TASK_CID_DIGEST,
  createdAtBlock: '100',
  createdAtTx: TASK_CREATED_TX,
};

const attempt = {
  taskId: TASK_ID,
  chainId: CHAIN_ID,
  attemptIndex: 0,
  requestId: REQUEST_ID,
  operator: OPERATOR,
  createdAtBlock: '110',
};

const envelope = {
  requestId: REQUEST_ID,
  chainId: CHAIN_ID,
  manifestCid: ENVELOPE_CID,
  publisherAgentId: '7',
  manifestHash: MANIFEST_HASH,
  enrichedAtBlock: '120',
};

const verdict = {
  taskId: TASK_ID,
  chainId: CHAIN_ID,
  attemptIndex: 0,
  verdictIndex: 1,
  requestId: VERDICT_REQUEST_ID,
  evaluator: EVALUATOR,
  verdictCode: 1,
  createdAtBlock: '115',
};

const verdictEnvelope = {
  taskId: TASK_ID,
  chainId: CHAIN_ID,
  attemptIndex: 0,
  verdictIndex: 1,
  requestId: VERDICT_REQUEST_ID,
  evaluator: EVALUATOR,
  manifestCid: ENVELOPE_CID,
  publisherAgentId: '8',
  manifestHash: MANIFEST_HASH,
  // Pre-adoption metadata is anchored before the optional Router verdict row.
  enrichedAtBlock: '112',
};

interface Script {
  tasks?: unknown[];
  attempts?: unknown[];
  envelopes?: unknown[];
  verdicts?: unknown[];
  verdictEnvelopes?: unknown[];
}

function scriptedFetch(script: Script) {
  const posts: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/ready')) return new Response(null, { status: 200 });
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    posts.push(body);
    const collection = body.query.includes('ExactAutopilotTask(')
      ? { tasks: { items: script.tasks ?? [] } }
      : body.query.includes('ExactAutopilotSolutionAttempts(')
        ? { attempts: { items: script.attempts ?? [] } }
        : body.query.includes('ExactAutopilotVerdicts(')
          ? { verdicts: { items: script.verdicts ?? [] } }
          : body.query.includes('ExactAutopilotVerdictEnvelopeMetadata(')
            ? { verdictEnvelopeMetas: { items: script.verdictEnvelopes ?? [] } }
            : { attemptEnvelopeMetas: { items: script.envelopes ?? [] } };
    return new Response(JSON.stringify({ data: collection }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, posts };
}

function clientFor(script: Script) {
  const scripted = scriptedFetch(script);
  return {
    api: createHttpDiscoveryAPI({
      url: INDEXER_URL,
      fetchImpl: scripted.fetchImpl,
      retryDelaysMs: [],
    }),
    posts: scripted.posts,
  };
}

describe('HttpDiscoveryAPI.getAutopilotDeliveryCandidates', () => {
  it('represents each not-yet-indexed stage as pending', async () => {
    const taskPending = clientFor({});
    await expect(taskPending.api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'solution',
    })).resolves.toEqual({
      status: 'pending',
      reason: 'task-not-indexed',
      taskId: TASK_ID,
      role: 'solution',
    });

    const attemptPending = clientFor({ tasks: [task] });
    await expect(attemptPending.api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'solution',
    })).resolves.toEqual({
      status: 'pending',
      reason: 'attempt-not-indexed',
      taskId: TASK_ID,
      role: 'solution',
    });

    const envelopePending = clientFor({ tasks: [task], attempts: [attempt] });
    await expect(envelopePending.api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'solution',
    })).resolves.toEqual({
      status: 'pending',
      reason: 'envelope-not-indexed',
      taskId: TASK_ID,
      role: 'solution',
    });
  });

  it('returns one exact task, solution attempt, and envelope candidate without a recent scan', async () => {
    const { api, posts } = clientFor({
      tasks: [task],
      attempts: [attempt],
      envelopes: [envelope],
    });

    await expect(api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'solution',
    })).resolves.toEqual({
      status: 'ready',
      role: 'solution',
      task: {
        taskId: TASK_ID,
        taskCidDigest: TASK_CID_DIGEST,
        createdAtBlock: 100,
        createdAtTx: TASK_CREATED_TX,
      },
      attempt: {
        taskId: TASK_ID,
        attemptIndex: 0,
        requestId: REQUEST_ID,
        operator: OPERATOR,
        createdAtBlock: 110,
      },
      solutionOperator: OPERATOR,
      envelope: {
        requestId: REQUEST_ID,
        manifestCid: ENVELOPE_CID,
        publisherAgentId: '7',
        manifestHash: MANIFEST_HASH,
        enrichedAtBlock: 120,
      },
    });

    expect(posts).toHaveLength(3);
    expect(posts.map(({ variables }) => variables)).toEqual([
      { taskId: TASK_ID, chainId: CHAIN_ID },
      { taskId: TASK_ID, chainId: CHAIN_ID },
      { requestId: REQUEST_ID, chainId: CHAIN_ID },
    ]);
    for (const { query } of posts) {
      expect(query).toContain('limit: 2');
      expect(query).not.toMatch(/Recent|orderDirection|offset|after/);
    }
  });

  it('classifies multiple attempts and envelope candidates as contradictions', async () => {
    const tasks = clientFor({
      tasks: [task, { ...task }],
    });
    await expect(tasks.api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'solution',
    })).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'multiple-tasks',
    });

    const attempts = clientFor({
      tasks: [task],
      attempts: [
        attempt,
        { ...attempt, attemptIndex: 1, requestId: `0x${'77'.repeat(32)}` },
      ],
    });
    await expect(attempts.api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'solution',
    })).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'multiple-attempts',
    });

    const envelopes = clientFor({
      tasks: [task],
      attempts: [attempt],
      envelopes: [
        envelope,
        { ...envelope, manifestCid: `f01551220${'88'.repeat(32)}` },
      ],
    });
    await expect(envelopes.api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'solution',
    })).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'multiple-envelopes',
    });
  });

  it('fails closed on inconsistent exact rows', async () => {
    const inconsistent = clientFor({
      tasks: [task],
      attempts: [{ ...attempt, taskId: '999' }],
    });
    await expect(inconsistent.api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'solution',
    })).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'inconsistent-indexer-data',
    });

  });

  it('resolves verdict delivery through the evaluation request and evaluator Safe', async () => {
    const fixture = clientFor({
      tasks: [task],
      attempts: [attempt],
      verdicts: [verdict],
      verdictEnvelopes: [verdictEnvelope],
    });

    await expect(fixture.api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'verdict',
    })).resolves.toEqual({
      status: 'ready',
      role: 'verdict',
      task: {
        taskId: TASK_ID,
        taskCidDigest: TASK_CID_DIGEST,
        createdAtBlock: 100,
        createdAtTx: TASK_CREATED_TX,
      },
      attempt: {
        taskId: TASK_ID,
        attemptIndex: 0,
        requestId: VERDICT_REQUEST_ID,
        operator: EVALUATOR,
        createdAtBlock: 115,
      },
      solutionOperator: OPERATOR,
      envelope: {
        requestId: VERDICT_REQUEST_ID,
        manifestCid: ENVELOPE_CID,
        publisherAgentId: '8',
        manifestHash: MANIFEST_HASH,
        enrichedAtBlock: 112,
      },
    });

    expect(fixture.posts.map(({ variables }) => variables)).toEqual([
      { taskId: TASK_ID, chainId: CHAIN_ID },
      { taskId: TASK_ID, chainId: CHAIN_ID },
      { taskId: TASK_ID, chainId: CHAIN_ID },
      { taskId: TASK_ID, chainId: CHAIN_ID },
    ]);
  });

  it('returns the exact pre-adoption verdict metadata when no Router verdict row exists yet', async () => {
    const fixture = clientFor({
      tasks: [task],
      attempts: [attempt],
      verdictEnvelopes: [verdictEnvelope],
    });

    await expect(fixture.api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'verdict',
    })).resolves.toEqual({
      status: 'ready',
      role: 'verdict',
      task: {
        taskId: TASK_ID,
        taskCidDigest: TASK_CID_DIGEST,
        createdAtBlock: 100,
        createdAtTx: TASK_CREATED_TX,
      },
      attempt: {
        taskId: TASK_ID,
        attemptIndex: 0,
        requestId: VERDICT_REQUEST_ID,
        operator: EVALUATOR,
        createdAtBlock: null,
      },
      solutionOperator: OPERATOR,
      envelope: {
        requestId: VERDICT_REQUEST_ID,
        manifestCid: ENVELOPE_CID,
        publisherAgentId: '8',
        manifestHash: MANIFEST_HASH,
        enrichedAtBlock: 112,
      },
    });
  });

  it('fails closed when verdict rows are ambiguous or do not join the solution attempt', async () => {
    const ambiguous = clientFor({
      tasks: [task],
      attempts: [attempt],
      verdictEnvelopes: [verdictEnvelope],
      verdicts: [verdict, { ...verdict, verdictIndex: 2 }],
    });
    await expect(ambiguous.api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'verdict',
    })).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'multiple-verdicts',
    });

    const wrongAttempt = clientFor({
      tasks: [task],
      attempts: [attempt],
      verdictEnvelopes: [verdictEnvelope],
      verdicts: [{ ...verdict, attemptIndex: 1 }],
    });
    await expect(wrongAttempt.api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'verdict',
    })).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'inconsistent-indexer-data',
    });
  });

  it('rejects an optional Router verdict row that conflicts with pre-adoption metadata', async () => {
    const fixture = clientFor({
      tasks: [task],
      attempts: [attempt],
      verdictEnvelopes: [verdictEnvelope],
      verdicts: [{
        ...verdict,
        requestId: `0x${'99'.repeat(32)}`,
      }],
    });

    await expect(fixture.api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'verdict',
    })).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'inconsistent-indexer-data',
    });
  });

  it('rejects ambiguous pre-adoption verdict metadata candidates', async () => {
    const fixture = clientFor({
      tasks: [task],
      attempts: [attempt],
      verdictEnvelopes: [
        verdictEnvelope,
        {
          ...verdictEnvelope,
          requestId: `0x${'98'.repeat(32)}`,
          manifestCid: `f01551220${'97'.repeat(32)}`,
        },
      ],
    });

    await expect(fixture.api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'verdict',
    })).resolves.toMatchObject({
      status: 'contradiction',
      reason: 'multiple-envelopes',
    });
  });
});
