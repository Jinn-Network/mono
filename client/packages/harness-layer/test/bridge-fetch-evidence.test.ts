import { describe, it, expect, vi } from 'vitest';
import {
  createEvidenceFetcher,
  type AuthenticatedExecutionEnvelope,
} from '../src/bridge-fetch-evidence.js';
import type { AttemptRef } from '../src/bridge.js';
import { makeTarGz, wrapDonation } from './tar-fixture.js';

function ref(over: Partial<AttemptRef> = {}): AttemptRef {
  return {
    requestId: '0x' + 'a'.repeat(64),
    chainId: 84532,
    instanceId: 'django__django-11333',
    model: '',
    manifestCid: '',
    polarity: 'pass',
    verdictManifestCid: 'bafyVerdict',
    ...over,
  };
}

const PATCH = 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-old\n+new\n';

const VERDICT_CID = 'bafyVerdict';
const TASK_CID = 'bafyTask';
const SOLUTION_CID = 'bafySolution';
const SNAPSHOT_CID = 'bafySnapshot';
const EVALUATION_REQ = '0x' + 'a'.repeat(64);
const SOLVE_REQ = '0x' + 'b'.repeat(64);
const TASK_ID = '42';
const EVALUATOR_SAFE = '0x' + '1'.repeat(40);
const SOLVER_SAFE = '0x' + '2'.repeat(40);
const ATTACKER_SAFE = '0x' + '3'.repeat(40);
const CREATOR_SAFE = '0x' + '6'.repeat(40);
const EVALUATOR_AGENT_ID = '101';
const SOLVER_AGENT_ID = '202';
const VERDICT_HASH = '0x' + '6'.repeat(64);
const SOLUTION_HASH = '0x' + '7'.repeat(64);
const TASK_CID_DIGEST = '0x' + 'a'.repeat(64);
const MANIFEST_DIGEST = '0x' + 'b'.repeat(64);
const ORIGINAL_TASK_CID = 'bafyOriginalTask';

const AUTHENTICATED_TASK = {
  solverType: 'swe-rebench-v2.v1',
  instanceId: 'django__django-11333',
  repo: 'django/django',
  baseCommit: 'a'.repeat(40),
  createdAt: 1_752_000_000_000,
  originalTaskCid: ORIGINAL_TASK_CID,
  creatorSafe: CREATOR_SAFE,
  manifestDigest: MANIFEST_DIGEST,
  description: 'Fix the widget factory',
};

// Mirrors the real jinn.execution.v1 TaskProvenanceSchema. solverType belongs
// to the outer envelope, not this nested task provenance object.
const AUTHENTICATED_ENVELOPE_TASK = {
  instanceId: AUTHENTICATED_TASK.instanceId,
  repo: AUTHENTICATED_TASK.repo,
  baseCommit: AUTHENTICATED_TASK.baseCommit,
  createdAt: 1_752_000_000,
};

function authenticatedVerifier(over: Record<string, unknown> = {}) {
  return {
    failToPass: ['tests/test_widget.py::test_regression'],
    passToPass: ['tests/test_widget.py::test_existing'],
    evalSemanticsVersion: '4',
    task: AUTHENTICATED_TASK,
    ...over,
  };
}

function signature(hash: string, signer: string) {
  return {
    algo: 'secp256k1',
    signer,
    hash,
    sig: '0x' + '8'.repeat(130),
  };
}

function boundVerdict(over: Record<string, unknown> = {}) {
  const agentEoa = '0x' + '5'.repeat(40);
  return {
    solverType: AUTHENTICATED_TASK.solverType,
    role: 'verdict',
    participant: {
      safeAddress: EVALUATOR_SAFE,
      agentEoa,
    },
    task: {
      cid: TASK_CID,
      requestId: EVALUATION_REQ,
      ...AUTHENTICATED_ENVELOPE_TASK,
    },
    payload: { passed_match: true },
    signature: signature(VERDICT_HASH, agentEoa),
    ...over,
  };
}

function boundSolution(over: Record<string, unknown> = {}) {
  const agentEoa = '0x' + '4'.repeat(40);
  return {
    solverType: AUTHENTICATED_TASK.solverType,
    role: 'solution',
    participant: {
      safeAddress: SOLVER_SAFE,
      agentEoa,
    },
    task: {
      cid: ORIGINAL_TASK_CID,
      requestId: SOLVE_REQ,
      ...AUTHENTICATED_ENVELOPE_TASK,
    },
    payload: { patch: PATCH },
    signature: signature(SOLUTION_HASH, agentEoa),
    ...over,
  };
}

function producerTask(over: Record<string, unknown> = {}) {
  return {
    description: 'Fix the widget factory',
    restorationRequestId: SOLVE_REQ,
    solverType: 'swe-rebench-v2.v1',
    spec: {
      schemaVersion: 'swe-rebench-v2.v1',
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2025_01',
      instance_id: 'django__django-11333',
      repo: 'django/django',
      base_commit: 'a'.repeat(40),
      problem_statement: 'Fix the widget factory',
    },
    ...over,
  };
}

/**
 * Canned ports for the VERIFIED join:
 *   verdict envelope → task doc + authoritative verdict/attempt chain tuple
 *   → attemptEnvelopeMetas → solution envelope patch.
 * Optionally registers a donation-wrapped system_snapshot under SNAPSHOT_CID
 * (§8 enrichment, #1472).
 */
function ports(over: {
  verdict?: unknown;
  task?: unknown;
  verdictRows?: unknown[];
  taskRows?: unknown[];
  verdictMetas?: unknown[];
  attemptRows?: unknown[];
  attemptMetas?: unknown[];
  solution?: unknown;
  snapshot?: unknown;
} = {}) {
  const ipfsStore: Record<string, unknown> = {
    [VERDICT_CID]: over.verdict ?? boundVerdict(),
    [TASK_CID]: over.task ?? { description: 'Fix the widget factory', restorationRequestId: SOLVE_REQ },
    [SOLUTION_CID]: over.solution ?? boundSolution(),
  };
  if (over.snapshot !== undefined) ipfsStore[SNAPSHOT_CID] = over.snapshot;
  return {
    ipfs: async (cid: string) => {
      if (!(cid in ipfsStore)) throw new Error(`ipfs test: unexpected cid ${cid}`);
      return ipfsStore[cid];
    },
    gql: async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes('AuthoritativeVerdictEnvelopeMeta')) {
        expect(variables).toEqual({ requestId: EVALUATION_REQ, chainId: 84532 });
        return {
          verdictEnvelopeMetas: {
            items: over.verdictMetas ?? [{
              requestId: EVALUATION_REQ,
              chainId: 84532,
              manifestCid: VERDICT_CID,
              publisherAgentId: EVALUATOR_AGENT_ID,
              manifestHash: VERDICT_HASH,
              enrichedAtBlock: '1000',
            }],
          },
        };
      }
      if (query.includes('AuthoritativeVerdict')) {
        expect(variables).toEqual({ requestId: EVALUATION_REQ, chainId: 84532 });
        return {
          verdicts: {
            items: over.verdictRows ?? [{
              requestId: EVALUATION_REQ,
              chainId: 84532,
              taskId: TASK_ID,
              attemptIndex: 0,
              evaluator: EVALUATOR_SAFE,
            }],
          },
        };
      }
      if (query.includes('AuthoritativeTask')) {
        expect(variables).toEqual({ taskId: TASK_ID, chainId: 84532 });
        return {
          tasks: {
            items: over.taskRows ?? [{
              id: TASK_ID,
              chainId: 84532,
              taskCidDigest: TASK_CID_DIGEST,
              manifestDigest: MANIFEST_DIGEST,
              creator: CREATOR_SAFE,
            }],
          },
        };
      }
      if (query.includes('AuthoritativeAttempt')) {
        expect(variables).toEqual({ taskId: TASK_ID, attemptIndex: 0, chainId: 84532 });
        return {
          attempts: {
            items: over.attemptRows ?? [{
              requestId: SOLVE_REQ,
              chainId: 84532,
              taskId: TASK_ID,
              attemptIndex: 0,
              operator: SOLVER_SAFE,
            }],
          },
        };
      }
      if (query.includes('SolutionEnvelopeMeta')) {
        expect(variables).toEqual({ requestId: SOLVE_REQ, chainId: 84532 });
        return {
          attemptEnvelopeMetas: {
            items: over.attemptMetas ?? [{
              requestId: SOLVE_REQ,
              chainId: 84532,
              manifestCid: SOLUTION_CID,
              publisherAgentId: SOLVER_AGENT_ID,
              manifestHash: SOLUTION_HASH,
              enrichedAtBlock: '2000',
            }],
          },
        };
      }
      throw new Error(`unexpected GraphQL query: ${query}`);
    },
    resolvePublisherSafe: async (
      _chainId: number,
      agentId: string,
      _publishedAtBlock: bigint,
    ) => {
      if (agentId === EVALUATOR_AGENT_ID) return EVALUATOR_SAFE;
      if (agentId === SOLVER_AGENT_ID) return SOLVER_SAFE;
      return ATTACKER_SAFE;
    },
    authenticateEnvelope: async (value: unknown, sourceName: string) => {
      const signature = value && typeof value === 'object'
        ? (value as Record<string, unknown>)['signature']
        : undefined;
      if (
        signature
        && typeof signature === 'object'
        && (signature as Record<string, unknown>)['hash'] === '0x' + '0'.repeat(64)
      ) {
        throw new Error(`${sourceName} signature hash mismatch`);
      }
      return value as AuthenticatedExecutionEnvelope;
    },
  };
}

describe('createEvidenceFetcher', () => {
  it('returns patch content but no unauthenticated provenance when no resolver is expected', async () => {
    const fetch = createEvidenceFetcher(ports());
    const ev = await fetch(ref());
    expect(ev.patch).toBe(PATCH);
    expect(ev.taskSummary).toBe('Fix the widget factory');
    expect(ev.repo).toBeUndefined();
  });

  it('resolves one atomic verifier tuple from the exact producer-shaped SWE task document', async () => {
    const task = producerTask();
    const verifier = authenticatedVerifier();
    const resolveVerifierFacts = vi.fn(async () => verifier);
    const fetch = createEvidenceFetcher({
      ...ports({ task }),
      resolveVerifierFacts,
    });

    const { task: authenticatedTask, ...verifierTuple } = verifier;
    await expect(fetch(ref())).resolves.toMatchObject({
      instanceId: authenticatedTask.instanceId,
      repo: authenticatedTask.repo,
      baseCommit: authenticatedTask.baseCommit,
      taskCreatedAt: authenticatedTask.createdAt,
      verifier: verifierTuple,
    });
    expect(resolveVerifierFacts).toHaveBeenCalledTimes(1);
    expect(resolveVerifierFacts).toHaveBeenCalledWith(
      task,
      ref().instanceId,
      {
        taskId: TASK_ID,
        chainId: 84532,
        taskCidDigest: TASK_CID_DIGEST,
        manifestDigest: MANIFEST_DIGEST,
        creatorSafe: CREATOR_SAFE,
        evaluatorSafe: EVALUATOR_SAFE,
      },
    );
  });

  it('requires solverType on the outer envelope even if a nested task copy claims it', async () => {
    const fetch = createEvidenceFetcher({
      ...ports({
        task: producerTask(),
        verdict: boundVerdict({
          solverType: undefined,
          task: {
            cid: TASK_CID,
            requestId: EVALUATION_REQ,
            solverType: AUTHENTICATED_TASK.solverType,
            ...AUTHENTICATED_ENVELOPE_TASK,
          },
        }),
      }),
      resolveVerifierFacts: async () => authenticatedVerifier(),
    });

    await expect(fetch(ref())).rejects.toThrow(
      /verdictEnvelope\.solverType requires exact authenticated task provenance/,
    );
  });

  it('recognizes the signed-task wrapper while deriving the solution join from authoritative chain rows', async () => {
    const signedTask = producerTask();
    delete signedTask['restorationRequestId'];
    const task = {
      description: 'forged outer description',
      signedTask,
    };
    const resolveVerifierFacts = vi.fn(async () => ({
      ...authenticatedVerifier(),
      failToPass: [],
    }));
    const fetch = createEvidenceFetcher({
      ...ports({ task }),
      resolveVerifierFacts,
    });

    await expect(fetch(ref())).resolves.toMatchObject({
      taskSummary: 'Fix the widget factory',
    });
    expect(resolveVerifierFacts).toHaveBeenCalledWith(
      task,
      ref().instanceId,
      expect.objectContaining({
        taskId: TASK_ID,
        taskCidDigest: TASK_CID_DIGEST,
        creatorSafe: CREATOR_SAFE,
      }),
    );
  });

  it('rejects a signed inner restorationRequestId masked by an agreeing outer wrapper', async () => {
    const task = {
      restorationRequestId: SOLVE_REQ,
      signedTask: producerTask({
        restorationRequestId: '0x' + 'c'.repeat(64),
      }),
    };
    const fetch = createEvidenceFetcher({
      ...ports({ task }),
      resolveVerifierFacts: async () => authenticatedVerifier(),
    });

    await expect(fetch(ref())).rejects.toThrow(
      /signed task restorationRequestId.*authoritative solution requestId/,
    );
  });

  it('rejects a verdict envelope whose signed polarity disagrees with the indexed candidate', async () => {
    const fetch = createEvidenceFetcher({
      ...ports({
        task: producerTask(),
        verdict: boundVerdict({
          task: {
            cid: TASK_CID,
            requestId: EVALUATION_REQ,
            ...AUTHENTICATED_ENVELOPE_TASK,
          },
          payload: { passed_match: false },
        }),
      }),
      resolveVerifierFacts: async () => authenticatedVerifier(),
    });

    await expect(fetch(ref({ polarity: 'pass' }))).rejects.toThrow(
      /signed verdict polarity.*indexed candidate/,
    );
  });

  it('rejects a verdict metadata publisher not bound to the on-chain evaluator', async () => {
    const fetch = createEvidenceFetcher({
      ...ports({
        task: producerTask(),
        verdictMetas: [{
          requestId: EVALUATION_REQ,
          chainId: 84532,
          manifestCid: VERDICT_CID,
          publisherAgentId: '999',
          manifestHash: VERDICT_HASH,
          enrichedAtBlock: '1000',
        }],
      }),
      resolveVerifierFacts: async () => authenticatedVerifier(),
    });

    await expect(fetch(ref())).rejects.toThrow(
      /verdict envelope publisher.*on-chain evaluator/,
    );
  });

  it('rejects a solution metadata publisher not bound to the on-chain operator', async () => {
    const fetch = createEvidenceFetcher({
      ...ports({
        task: producerTask(),
        attemptMetas: [{
          requestId: SOLVE_REQ,
          chainId: 84532,
          manifestCid: SOLUTION_CID,
          publisherAgentId: '999',
          manifestHash: SOLUTION_HASH,
          enrichedAtBlock: '2000',
        }],
      }),
      resolveVerifierFacts: async () => authenticatedVerifier(),
    });

    await expect(fetch(ref())).rejects.toThrow(
      /solution envelope publisher.*on-chain operator/,
    );
  });

  it('recovers the legitimate verdict candidate after an attacker publishes the same request id', async () => {
    const fetch = createEvidenceFetcher(ports({
      verdictMetas: [
        {
          requestId: EVALUATION_REQ,
          chainId: 84532,
          manifestCid: 'bafyAttackerVerdict',
          publisherAgentId: '999',
          manifestHash: '0x' + '9'.repeat(64),
          enrichedAtBlock: '3000',
        },
        {
          requestId: EVALUATION_REQ,
          chainId: 84532,
          manifestCid: VERDICT_CID,
          publisherAgentId: EVALUATOR_AGENT_ID,
          manifestHash: VERDICT_HASH,
          enrichedAtBlock: '1000',
        },
      ],
    }));

    await expect(fetch(ref({
      verdictManifestCid: 'bafyAttackerVerdict',
    }))).resolves.toMatchObject({ patch: PATCH });
  });

  it('does not let an untrusted enrichment instance projection relabel authenticated task facts', async () => {
    const fetch = createEvidenceFetcher({
      ...ports({ task: producerTask() }),
      resolveVerifierFacts: async () => authenticatedVerifier(),
    });

    await expect(fetch(ref({
      instanceId: 'attacker__metadata-9',
    }))).resolves.toMatchObject({
      instanceId: AUTHENTICATED_TASK.instanceId,
      taskSummary: AUTHENTICATED_TASK.description,
    });
  });

  it('recovers the legitimate solution candidate after an attacker publishes the same request id', async () => {
    const fetch = createEvidenceFetcher(ports({
      attemptMetas: [
        {
          requestId: SOLVE_REQ,
          chainId: 84532,
          manifestCid: 'bafyAttackerSolution',
          publisherAgentId: '999',
          manifestHash: '0x' + '9'.repeat(64),
          enrichedAtBlock: '3000',
        },
        {
          requestId: SOLVE_REQ,
          chainId: 84532,
          manifestCid: SOLUTION_CID,
          publisherAgentId: SOLVER_AGENT_ID,
          manifestHash: SOLUTION_HASH,
          enrichedAtBlock: '2000',
        },
      ],
    }));

    await expect(fetch(ref())).resolves.toMatchObject({ patch: PATCH });
  });

  it('rejects a verdict whose signed hash is not the MetadataSet commitment', async () => {
    const fetch = createEvidenceFetcher(ports({
      verdictMetas: [{
        requestId: EVALUATION_REQ,
        chainId: 84532,
        manifestCid: VERDICT_CID,
        publisherAgentId: EVALUATOR_AGENT_ID,
        manifestHash: '0x' + '9'.repeat(64),
        enrichedAtBlock: '1000',
      }],
    }));

    await expect(fetch(ref())).rejects.toThrow(
      /verdict envelope signature hash.*MetadataSet manifest hash/,
    );
  });

  it('rejects a solution participant Safe relabelled onto the on-chain operator', async () => {
    const fetch = createEvidenceFetcher(ports({
      solution: boundSolution({
        participant: {
          safeAddress: ATTACKER_SAFE,
          agentEoa: '0x' + '4'.repeat(40),
        },
      }),
    }));

    await expect(fetch(ref())).rejects.toThrow(
      /solution envelope participant Safe.*on-chain operator/,
    );
  });

  it('rejects a legacy restoration role at the exact solution boundary', async () => {
    const fetch = createEvidenceFetcher(ports({
      solution: boundSolution({ role: 'restoration' }),
    }));

    await expect(fetch(ref())).rejects.toThrow(
      /solutionEnvelope\.role must be exactly solution/,
    );
  });

  it('rejects a tampered verdict envelope before trusting its payload', async () => {
    const fetch = createEvidenceFetcher({
      ...ports({
        task: producerTask(),
        verdict: boundVerdict({
          task: {
            cid: TASK_CID,
            requestId: EVALUATION_REQ,
            ...AUTHENTICATED_ENVELOPE_TASK,
          },
          payload: { passed_match: true },
          signature: signature('0x' + '0'.repeat(64), '0x' + '5'.repeat(40)),
        }),
      }),
      resolveVerifierFacts: async () => authenticatedVerifier(),
    });

    await expect(fetch(ref())).rejects.toThrow(/verdictEnvelope.*signature/i);
  });

  it('rejects a mutable outer restorationRequestId that disagrees with the authoritative attempt', async () => {
    const fetch = createEvidenceFetcher({
      ...ports({
        task: producerTask({
          restorationRequestId: '0x' + 'c'.repeat(64),
        }),
      }),
      resolveVerifierFacts: async () => authenticatedVerifier(),
    });

    await expect(fetch(ref())).rejects.toThrow(
      /mutable task restorationRequestId.*authoritative solution requestId/,
    );
  });

  it('rejects verifier facts whose original task lineage disagrees with TaskCreated', async () => {
    const fetch = createEvidenceFetcher({
      ...ports({
        task: producerTask(),
        taskRows: [{
          id: TASK_ID,
          chainId: 84532,
          taskCidDigest: TASK_CID_DIGEST,
          manifestDigest: '0x' + 'c'.repeat(64),
          creator: CREATOR_SAFE,
        }],
      }),
      resolveVerifierFacts: async () => authenticatedVerifier(),
    });

    await expect(fetch(ref())).rejects.toThrow(
      /authenticated task manifest digest.*TaskCreated/,
    );
  });

  it.each([
    ['missing', undefined],
    ['misspelled', 'swe-rebench-v2.vl'],
    ['non-SWE', 'prediction.v1'],
  ])('fails closed when an expected verifier task type is %s', async (_name, solverType) => {
    const task = producerTask({ solverType });
    if (solverType === undefined) delete task['solverType'];
    const resolveVerifierFacts = vi.fn(async () => authenticatedVerifier());
    const fetch = createEvidenceFetcher({
      ...ports({ task }),
      resolveVerifierFacts,
    });

    await expect(fetch(ref())).rejects.toThrow(/exact swe-rebench-v2\.v1 task type/);
  });

  it('rejects authenticated task-A facts relabeled by task-B envelope and verdict provenance', async () => {
    const taskB = {
      instanceId: 'flask__flask-4200',
      repo: 'pallets/flask',
      baseCommit: 'b'.repeat(40),
      createdAt: 1_753_000_000,
    };
    const fetch = createEvidenceFetcher({
      ...ports({
        task: producerTask({
          spec: {
            ...producerTask().spec,
            instance_id: taskB.instanceId,
            repo: taskB.repo,
            base_commit: taskB.baseCommit,
          },
        }),
        verdict: boundVerdict({
          task: { cid: TASK_CID, requestId: EVALUATION_REQ, ...taskB },
        }),
        solution: boundSolution({
          task: { cid: 'bafyOriginalTask', requestId: SOLVE_REQ, ...taskB },
          payload: { patch: PATCH },
        }),
      }),
      resolveVerifierFacts: async () => authenticatedVerifier(),
    });

    await expect(fetch(ref({
      instanceId: taskB.instanceId,
    }))).rejects.toThrow(/authenticated task provenance mismatch.*instanceId/);
  });

  it('publishes signed-task createdAt and never lets chain-event envelope timestamps override it', async () => {
    const envelopeTask = {
      instanceId: AUTHENTICATED_TASK.instanceId,
      repo: AUTHENTICATED_TASK.repo,
      baseCommit: AUTHENTICATED_TASK.baseCommit,
      // Envelope task.createdAt is TaskCreated block time in epoch seconds,
      // not the signed TaskV1 creation time in epoch milliseconds.
      createdAt: 1_752_000_000,
    };
    const fetch = createEvidenceFetcher({
      ...ports({
        task: producerTask(),
        verdict: boundVerdict({
          task: { cid: TASK_CID, requestId: EVALUATION_REQ, ...envelopeTask },
        }),
        solution: boundSolution({
          task: { cid: 'bafyOriginalTask', requestId: SOLVE_REQ, ...envelopeTask },
          payload: { patch: PATCH },
        }),
      }),
      resolveVerifierFacts: async () => authenticatedVerifier(),
    });

    await expect(fetch(ref())).resolves.toMatchObject({
      taskCreatedAt: AUTHENTICATED_TASK.createdAt,
    });
  });

  it.each([
    {
      name: 'identified task has no verifier resolver',
      task: producerTask(),
      resolveVerifierFacts: undefined,
      error: /requires authenticated verifier facts/,
    },
    {
      name: 'resolver rejects its proof',
      task: producerTask(),
      resolveVerifierFacts: async () => {
        throw new Error('artifact digest mismatch');
      },
      error: /artifact digest mismatch/,
    },
    {
      name: 'resolver returns no tuple',
      task: producerTask(),
      resolveVerifierFacts: async () => undefined,
      error: /must be an object/,
    },
    {
      name: 'resolver omits fail-to-pass',
      task: producerTask(),
      resolveVerifierFacts: async () => ({
        passToPass: ['tests/test_widget.py::test_existing'],
        evalSemanticsVersion: '4',
      }),
      error: /require exact failToPass, passToPass, and evalSemanticsVersion/,
    },
    {
      name: 'resolver omits pass-to-pass',
      task: producerTask(),
      resolveVerifierFacts: async () => ({
        failToPass: ['tests/test_widget.py::test_regression'],
        evalSemanticsVersion: '4',
      }),
      error: /require exact failToPass, passToPass, and evalSemanticsVersion/,
    },
    {
      name: 'resolver omits semantics version',
      task: producerTask(),
      resolveVerifierFacts: async () => ({
        failToPass: ['tests/test_widget.py::test_regression'],
        passToPass: ['tests/test_widget.py::test_existing'],
      }),
      error: /require exact failToPass, passToPass, and evalSemanticsVersion/,
    },
    {
      name: 'resolver returns a non-string array member',
      task: producerTask(),
      resolveVerifierFacts: async () => ({
        failToPass: ['tests/test_widget.py::test_regression', 7],
        passToPass: ['tests/test_widget.py::test_existing'],
        evalSemanticsVersion: '4',
      }),
      error: /require exact failToPass, passToPass, and evalSemanticsVersion/,
    },
    {
      name: 'resolver returns a blank semantics version',
      task: producerTask(),
      resolveVerifierFacts: async () => ({
        failToPass: ['tests/test_widget.py::test_regression'],
        passToPass: ['tests/test_widget.py::test_existing'],
        evalSemanticsVersion: '',
      }),
      error: /require exact failToPass, passToPass, and evalSemanticsVersion/,
    },
  ])('fails loud when $name', async ({ task, resolveVerifierFacts, error }) => {
    const fetch = createEvidenceFetcher({
      ...ports({ task }),
      ...(resolveVerifierFacts ? { resolveVerifierFacts } : {}),
    });

    await expect(fetch(ref())).rejects.toThrow(error);
  });

  it('falls back to spec.problem_statement when there is no description', async () => {
    const fetch = createEvidenceFetcher(
      ports({ task: { spec: { problem_statement: 'Repair the flux' }, restorationRequestId: SOLVE_REQ } }),
    );
    const ev = await fetch(ref());
    expect(ev.taskSummary).toBe('Repair the flux');
  });

  it('falls back to the instance id when the task doc has no problem statement', async () => {
    const fetch = createEvidenceFetcher(ports({ task: { restorationRequestId: SOLVE_REQ } }));
    const ev = await fetch(ref());
    expect(ev.taskSummary).toBe('django__django-11333');
  });

  it('scopes every authoritative join by chain and requires the unique on-chain task tuple', async () => {
    const basePorts = ports({ task: producerTask() });
    const gql = vi.fn(basePorts.gql);
    const fetch = createEvidenceFetcher({
      ...basePorts,
      gql,
      resolveVerifierFacts: async () => authenticatedVerifier(),
    });

    await expect(fetch(ref())).resolves.toMatchObject({ patch: PATCH });
    expect(gql).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('AuthoritativeVerdict'),
      { requestId: EVALUATION_REQ, chainId: 84532 },
    );
    expect(gql).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('AuthoritativeTask'),
      { taskId: TASK_ID, chainId: 84532 },
    );
    expect(gql).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('AuthoritativeVerdictEnvelopeMeta'),
      { requestId: EVALUATION_REQ, chainId: 84532 },
    );
    expect(gql).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('AuthoritativeAttempt'),
      { taskId: TASK_ID, attemptIndex: 0, chainId: 84532 },
    );
    expect(gql).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('SolutionEnvelopeMeta'),
      { requestId: SOLVE_REQ, chainId: 84532 },
    );
  });

  it('omits repo when the instance id does not match owner__repo-N', async () => {
    const fetch = createEvidenceFetcher(ports());
    const ev = await fetch(ref({ instanceId: 'not-an-instance' }));
    expect(ev.repo).toBeUndefined();
  });

  it('throws when the ref carries no verdictManifestCid', async () => {
    const fetch = createEvidenceFetcher(ports());
    await expect(fetch(ref({ verdictManifestCid: undefined }))).rejects.toThrow(/no verdictManifestCid/);
  });

  it('throws when the verdict envelope has no task.cid', async () => {
    const fetch = createEvidenceFetcher(ports({ verdict: boundVerdict({ task: {} }) }));
    await expect(fetch(ref())).rejects.toThrow(/no task\.cid/);
  });

  it('does not select a solution from an unauthenticated task restorationRequestId', async () => {
    const fetch = createEvidenceFetcher(ports({ task: { description: 'x' } }));
    await expect(fetch(ref())).resolves.toMatchObject({ patch: PATCH });
  });

  it.each([
    ['verdict', { verdictRows: [] }, /exactly one authoritative verdict/],
    ['task', { taskRows: [] }, /exactly one authoritative task/],
    ['verdict envelope', { verdictMetas: [] }, /at least one verdict envelope metadata row/],
    ['attempt', { attemptRows: [] }, /exactly one authoritative attempt/],
    ['solution envelope', { attemptMetas: [] }, /at least one solution envelope metadata row/],
  ])('fails closed when the %s chain join is missing', async (_name, over, error) => {
    const fetch = createEvidenceFetcher(ports(over));
    await expect(fetch(ref())).rejects.toThrow(error);
  });

  it('fails closed when an authoritative tuple lookup is ambiguous', async () => {
    const duplicate = {
      requestId: EVALUATION_REQ,
      chainId: 84532,
      taskId: TASK_ID,
      attemptIndex: 0,
    };
    const fetch = createEvidenceFetcher(ports({ verdictRows: [duplicate, duplicate] }));
    await expect(fetch(ref())).rejects.toThrow(/exactly one authoritative verdict/);
  });

  it('throws when no attemptEnvelopeMeta joins the solve request', async () => {
    const fetch = createEvidenceFetcher(ports({ attemptMetas: [] }));
    await expect(fetch(ref())).rejects.toThrow(/at least one solution envelope metadata row/);
  });

  it('throws when the solution envelope has no payload.patch', async () => {
    const fetch = createEvidenceFetcher(ports({
      solution: boundSolution({
        task: {
          cid: 'bafyOriginalTask',
          requestId: SOLVE_REQ,
          ...AUTHENTICATED_ENVELOPE_TASK,
        },
        payload: {},
      }),
    }));
    await expect(fetch(ref())).rejects.toThrow(/no payload\.patch/);
  });

  it('accepts a historical solution envelope whose copied task provenance is absent', async () => {
    const fetch = createEvidenceFetcher({
      ...ports({
        task: producerTask(),
        solution: boundSolution({
          task: { cid: 'bafyOriginalTask', requestId: SOLVE_REQ },
          payload: { patch: PATCH },
        }),
      }),
      resolveVerifierFacts: async () => authenticatedVerifier(),
    });

    await expect(fetch(ref())).resolves.toMatchObject({
      patch: PATCH,
      repo: AUTHENTICATED_TASK.repo,
      baseCommit: AUTHENTICATED_TASK.baseCommit,
    });
  });
});

describe('createEvidenceFetcher — snapshot-transcript enrichment (§8, #1472)', () => {
  const CLAUDE_JSONL = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'plan the certificate fix' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/path/to/x.py' } }] } }),
  ].join('\n');

  /** A solution envelope carrying a real (in-memory) system_snapshot artifact. */
  function solutionWithSnapshot(files: Record<string, string>) {
    const { wrapper, sha256 } = wrapDonation(makeTarGz(files));
    return {
      solution: boundSolution({
        artifacts: [{ artifactType: 'system_snapshot', sha256, sources: [{ cid: SNAPSHOT_CID, sha256 }] }],
      }),
      snapshot: wrapper,
    };
  }

  it('derives the step trace from the claude-code transcript inside system_snapshot', async () => {
    const fetch = createEvidenceFetcher(ports(solutionWithSnapshot({ '.claude-code/stdout.jsonl': CLAUDE_JSONL, 'task.json': '{}' })));
    const ev = await fetch(ref());
    expect(ev.stepTrace).toBeDefined();
    expect(ev.stepTrace).toContain('plan the certificate fix');
    expect(ev.stepTrace).toMatch(/- tool Edit:/);
    expect(ev.patch).toBe(PATCH); // enrichment never displaces the patch
  });

  it('derives the step trace from the codex transcript inside system_snapshot', async () => {
    const codexJsonl = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pytest -x', exit_code: 0 } });
    const fetch = createEvidenceFetcher(ports(solutionWithSnapshot({ '.codex-code/stdout.jsonl': codexJsonl })));
    const ev = await fetch(ref());
    expect(ev.stepTrace).toContain('- cmd: pytest -x');
  });

  it('caps the step trace at MAX_TRACE_CHARS (4000)', async () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `step number ${i} does a thing in detail` }] } }),
    ).join('\n');
    const fetch = createEvidenceFetcher(ports(solutionWithSnapshot({ '.claude-code/stdout.jsonl': many })));
    const ev = await fetch(ref());
    expect(ev.stepTrace!.length).toBeLessThanOrEqual(4000);
  });

  it('degrades to no step trace for a hermes-style snapshot (plain-text log, no decision path)', async () => {
    const fetch = createEvidenceFetcher(ports(solutionWithSnapshot({ '.hermes-agent/stdout.log': 'started\ndone\n' })));
    const ev = await fetch(ref());
    expect(ev.stepTrace).toBeUndefined();
    expect(ev.patch).toBe(PATCH);
  });

  it('degrades to no step trace when the solution has no system_snapshot artifact', async () => {
    const fetch = createEvidenceFetcher(ports()); // default solution carries no artifacts
    const ev = await fetch(ref());
    expect(ev.stepTrace).toBeUndefined();
    expect(ev.patch).toBe(PATCH);
  });

  it('degrades to no step trace when the snapshot fetch throws (never fails the whole evidence fetch)', async () => {
    const fetch = createEvidenceFetcher(
      ports({
        solution: boundSolution({
          // references a cid that is NOT registered → the ipfs port throws on that hop
          artifacts: [{ artifactType: 'system_snapshot', sha256: 'a'.repeat(64), sources: [{ cid: 'bafyMissing' }] }],
        }),
      }),
    );
    const ev = await fetch(ref());
    expect(ev.stepTrace).toBeUndefined();
    expect(ev.patch).toBe(PATCH);
  });

  it('degrades to no step trace on a sha256 mismatch (tampered snapshot)', async () => {
    const { wrapper } = wrapDonation(makeTarGz({ '.claude-code/stdout.jsonl': CLAUDE_JSONL }));
    const fetch = createEvidenceFetcher(
      ports({
        solution: boundSolution({
          artifacts: [{ artifactType: 'system_snapshot', sha256: 'f'.repeat(64), sources: [{ cid: SNAPSHOT_CID }] }],
        }),
        snapshot: wrapper,
      }),
    );
    const ev = await fetch(ref());
    expect(ev.stepTrace).toBeUndefined();
    expect(ev.patch).toBe(PATCH);
  });

  it('degrades to no step trace on corrupt snapshot bytes', async () => {
    const bogus = Buffer.from('definitely not a tarball');
    const { wrapper, sha256 } = wrapDonation(bogus);
    const fetch = createEvidenceFetcher(
      ports({
        solution: boundSolution({
          artifacts: [{ artifactType: 'system_snapshot', sha256, sources: [{ cid: SNAPSHOT_CID }] }],
        }),
        snapshot: wrapper,
      }),
    );
    const ev = await fetch(ref());
    expect(ev.stepTrace).toBeUndefined();
    expect(ev.patch).toBe(PATCH);
  });
});
