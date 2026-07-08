import { describe, it, expect } from 'vitest';
import { createEvidenceFetcher } from '../src/bridge-fetch-evidence.js';
import type { AttemptRef } from '../src/bridge.js';

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
const TRAJECTORY_CID = 'bafyTrajectory';
const SOLVE_REQ = '0x' + 'b'.repeat(64);

/** A minimal jinn.trajectory.v1-shaped doc — only the fields the compressor reads. */
function traj(spans: Array<{ name: string; kind?: string }>) {
  return {
    schemaVersion: 'jinn.trajectory.v1',
    spans: spans.map((s) => ({ name: s.name, attributes: { 'jinn.span.kind': s.kind ?? 'jinn.phase' } })),
  };
}

/**
 * Canned ports for the VERIFIED 3-hop join:
 *   verdict envelope → task doc → attemptEnvelopeMetas → solution envelope patch.
 * Optionally registers a trajectory doc under TRAJECTORY_CID (§8 enrichment).
 */
function ports(over: {
  verdict?: unknown;
  task?: unknown;
  attempts?: { manifestCid: string }[];
  solution?: unknown;
  trajectory?: unknown;
} = {}) {
  const ipfsStore: Record<string, unknown> = {
    [VERDICT_CID]: over.verdict ?? { task: { cid: TASK_CID } },
    [TASK_CID]: over.task ?? { description: 'Fix the widget factory', restorationRequestId: SOLVE_REQ },
    [SOLUTION_CID]: over.solution ?? { payload: { patch: PATCH } },
  };
  if (over.trajectory !== undefined) ipfsStore[TRAJECTORY_CID] = over.trajectory;
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

describe('createEvidenceFetcher — solver-trajectory enrichment (§8, v0.5)', () => {
  it('includes a compressed step trace when the solution envelope carries a top-level trajectory ref', async () => {
    const fetch = createEvidenceFetcher(
      ports({
        solution: { payload: { patch: PATCH }, trajectory: { sources: [{ cid: TRAJECTORY_CID }] } },
        trajectory: traj([
          { name: 'plan the fix', kind: 'jinn.phase' },
          { name: 'edit models.py', kind: 'jinn.mcp_call' },
        ]),
      }),
    );
    const ev = await fetch(ref());
    expect(ev.stepTrace).toBeDefined();
    expect(ev.stepTrace).toContain('plan the fix');
    expect(ev.stepTrace).toContain('edit models.py');
    expect(ev.stepTrace).toContain('jinn.mcp_call');
    expect(ev.patch).toBe(PATCH); // enrichment never displaces the patch
  });

  it('resolves the trajectory ref from an artifact producedBy.trajectoryCid fallback', async () => {
    const fetch = createEvidenceFetcher(
      ports({
        solution: {
          payload: { patch: PATCH },
          artifacts: [{ metadata: { producedBy: { trajectoryCid: TRAJECTORY_CID } } }],
        },
        trajectory: traj([{ name: 'run tests', kind: 'jinn.venue_io' }]),
      }),
    );
    const ev = await fetch(ref());
    expect(ev.stepTrace).toContain('run tests');
  });

  it('caps the step trace at MAX_TRACE_CHARS (4000)', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ name: `step number ${i} does a thing`, kind: 'jinn.phase' }));
    const fetch = createEvidenceFetcher(
      ports({
        solution: { payload: { patch: PATCH }, trajectory: { sources: [{ cid: TRAJECTORY_CID }] } },
        trajectory: traj(many),
      }),
    );
    const ev = await fetch(ref());
    expect(ev.stepTrace!.length).toBeLessThanOrEqual(4000);
  });

  it('degrades to no step trace when the solution envelope has no trajectory ref (patch still returned)', async () => {
    const fetch = createEvidenceFetcher(ports()); // default solution carries no trajectory
    const ev = await fetch(ref());
    expect(ev.stepTrace).toBeUndefined();
    expect(ev.patch).toBe(PATCH);
  });

  it('degrades to no step trace when the trajectory fetch throws (never fails the whole evidence fetch)', async () => {
    const fetch = createEvidenceFetcher(
      ports({
        // references a cid that is NOT registered → the ipfs port throws on that hop
        solution: { payload: { patch: PATCH }, trajectory: { sources: [{ cid: 'bafyMissing' }] } },
      }),
    );
    const ev = await fetch(ref());
    expect(ev.stepTrace).toBeUndefined();
    expect(ev.patch).toBe(PATCH);
  });
});
