import { describe, it, expect, vi } from 'vitest';
import { createEvidenceFetcher } from '../src/bridge-fetch-evidence.js';
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
const SOLVE_REQ = '0x' + 'b'.repeat(64);

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
 * Canned ports for the VERIFIED 3-hop join:
 *   verdict envelope → task doc → attemptEnvelopeMetas → solution envelope patch.
 * Optionally registers a donation-wrapped system_snapshot under SNAPSHOT_CID
 * (§8 enrichment, #1472).
 */
function ports(over: {
  verdict?: unknown;
  task?: unknown;
  attempts?: { manifestCid: string }[];
  solution?: unknown;
  snapshot?: unknown;
} = {}) {
  const ipfsStore: Record<string, unknown> = {
    [VERDICT_CID]: over.verdict ?? { task: { cid: TASK_CID } },
    [TASK_CID]: over.task ?? { description: 'Fix the widget factory', restorationRequestId: SOLVE_REQ },
    [SOLUTION_CID]: over.solution ?? { payload: { patch: PATCH } },
  };
  if (over.snapshot !== undefined) ipfsStore[SNAPSHOT_CID] = over.snapshot;
  return {
    ipfs: async (cid: string) => {
      if (!(cid in ipfsStore)) throw new Error(`ipfs test: unexpected cid ${cid}`);
      return ipfsStore[cid];
    },
    gql: async (query: string) => {
      expect(query).toContain(SOLVE_REQ);
      return { attemptEnvelopeMetas: { items: over.attempts ?? [{ manifestCid: SOLUTION_CID }] } };
    },
  };
}

describe('createEvidenceFetcher', () => {
  it('returns { taskSummary, patch, repo } via the 3-hop verdict→solution join', async () => {
    const fetch = createEvidenceFetcher(ports());
    const ev = await fetch(ref());
    expect(ev.patch).toBe(PATCH);
    expect(ev.taskSummary).toBe('Fix the widget factory');
    expect(ev.repo).toBe('django/django');
  });

  it('resolves one atomic verifier tuple from the exact producer-shaped SWE task document', async () => {
    const task = producerTask();
    const verifier = {
      failToPass: ['tests/test_widget.py::test_regression'],
      passToPass: ['tests/test_widget.py::test_existing'],
      evalSemanticsVersion: '4',
    };
    const resolveVerifierFacts = vi.fn(async () => verifier);
    const fetch = createEvidenceFetcher({
      ...ports({ task }),
      resolveVerifierFacts,
    });

    await expect(fetch(ref())).resolves.toMatchObject({
      verifier,
    });
    expect(resolveVerifierFacts).toHaveBeenCalledTimes(1);
    expect(resolveVerifierFacts).toHaveBeenCalledWith(task, ref().instanceId);
  });

  it('recognizes the signed-task wrapper and passes the complete outer document to the resolver', async () => {
    const signedTask = producerTask();
    delete signedTask['restorationRequestId'];
    const task = {
      restorationRequestId: SOLVE_REQ,
      signedTask,
    };
    const resolveVerifierFacts = vi.fn(async () => ({
      failToPass: [],
      passToPass: ['tests/test_widget.py::test_existing'],
      evalSemanticsVersion: '4',
    }));
    const fetch = createEvidenceFetcher({
      ...ports({ task }),
      resolveVerifierFacts,
    });

    await fetch(ref());
    expect(resolveVerifierFacts).toHaveBeenCalledWith(task, ref().instanceId);
  });

  it('does not project unauthenticated legacy verifier fields or call the resolver for non-SWE tasks', async () => {
    const resolveVerifierFacts = vi.fn();
    const fetch = createEvidenceFetcher({
      ...ports({
        task: {
          description: 'Fix the widget factory',
          restorationRequestId: SOLVE_REQ,
          spec: {
            instance_id: 'django__django-11333',
            repo: 'django/django',
            base_commit: 'a'.repeat(40),
            fail_to_pass: ['tests/test_widget.py::test_regression'],
            pass_to_pass: ['tests/test_widget.py::test_existing'],
            evalSemanticsVersion: '4',
          },
        },
        solution: {
          task: {
            instanceId: 'django__django-11333',
            repo: 'django/django',
            baseCommit: 'a'.repeat(40),
            createdAt: 1_752_000_000,
          },
          executor: {
            generatorModel: {
              id: 'claude-sonnet-4-6',
              provider: 'anthropic',
              source: 'stream',
            },
          },
          distributionClass: 'restricted-tos',
          payload: { patch: PATCH },
        },
      }),
      resolveVerifierFacts,
    });

    const evidence = await fetch(ref());
    expect(evidence).toMatchObject({
      instanceId: 'django__django-11333',
      repo: 'django/django',
      baseCommit: 'a'.repeat(40),
      taskCreatedAt: 1_752_000_000,
      generatorModel: {
        id: 'claude-sonnet-4-6',
        provider: 'anthropic',
        source: 'stream',
      },
      distributionClass: 'restricted-tos',
    });
    expect(evidence.verifier).toBeUndefined();
    expect(resolveVerifierFacts).not.toHaveBeenCalled();
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
    const fetch = createEvidenceFetcher(ports({ verdict: { task: {} } }));
    await expect(fetch(ref())).rejects.toThrow(/no task\.cid/);
  });

  it('throws when the task doc has no restorationRequestId', async () => {
    const fetch = createEvidenceFetcher(ports({ task: { description: 'x' } }));
    await expect(fetch(ref())).rejects.toThrow(/no restorationRequestId/);
  });

  it('throws when no attemptEnvelopeMeta joins the solve request', async () => {
    const fetch = createEvidenceFetcher(ports({ attempts: [] }));
    await expect(fetch(ref())).rejects.toThrow(/no attemptEnvelopeMeta/);
  });

  it('throws when the solution envelope has no payload.patch', async () => {
    const fetch = createEvidenceFetcher(ports({ solution: { payload: {} } }));
    await expect(fetch(ref())).rejects.toThrow(/no payload\.patch/);
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
      solution: {
        payload: { patch: PATCH },
        artifacts: [{ artifactType: 'system_snapshot', sha256, sources: [{ cid: SNAPSHOT_CID, sha256 }] }],
      },
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
        solution: {
          payload: { patch: PATCH },
          // references a cid that is NOT registered → the ipfs port throws on that hop
          artifacts: [{ artifactType: 'system_snapshot', sha256: 'a'.repeat(64), sources: [{ cid: 'bafyMissing' }] }],
        },
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
        solution: {
          payload: { patch: PATCH },
          artifacts: [{ artifactType: 'system_snapshot', sha256: 'f'.repeat(64), sources: [{ cid: SNAPSHOT_CID }] }],
        },
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
        solution: {
          payload: { patch: PATCH },
          artifacts: [{ artifactType: 'system_snapshot', sha256, sources: [{ cid: SNAPSHOT_CID }] }],
        },
        snapshot: wrapper,
      }),
    );
    const ev = await fetch(ref());
    expect(ev.stepTrace).toBeUndefined();
    expect(ev.patch).toBe(PATCH);
  });
});
