import { describe, expect, it, vi } from 'vitest';

import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';

const INDEXER_URL = 'https://indexer.example';
const CHAIN_ID = 84532;
const TASK_ID = '501';
const REQUEST_ID = `0x${'11'.repeat(32)}` as const;
const OPERATOR = `0x${'22'.repeat(20)}` as const;
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

interface Script {
  tasks?: unknown[];
  attempts?: unknown[];
  envelopes?: unknown[];
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

  it('fails closed on inconsistent exact rows and leaves verdict additive', async () => {
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

    const verdict = clientFor({});
    await expect(verdict.api.getAutopilotDeliveryCandidates({
      chainId: CHAIN_ID,
      taskId: TASK_ID,
      role: 'verdict',
    })).resolves.toEqual({
      status: 'pending',
      reason: 'role-not-supported',
      taskId: TASK_ID,
      role: 'verdict',
    });
    expect(verdict.posts).toHaveLength(0);
  });
});
