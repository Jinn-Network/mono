/**
 * Reader tests for #2044. The transport's fetch is injected via
 * `HttpDiscoveryClientOptions.fetchImpl` — the DI seam the module already
 * exposes for exactly this, so no `vi.mock` is needed
 * (docs/runbooks/testing.md: "inject the dep instead").
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createTaskLifecycleReader,
  type TaskLifecycleReader,
} from '../../src/discovery-client/task-lifecycle-http.js';
import type { HttpDiscoveryClientOptions } from '../../src/discovery-client/http.js';

const hex32 = (n: string) => `0x${n.repeat(32)}`;
const addr = (n: string) => `0x${n.repeat(20)}`;

/** True for the host-root `/ready` probe the shared transport issues. */
function isReadyProbe(url: string): boolean {
  return url.endsWith('/ready');
}

/** One exhausted GraphQL page for `root`. Tests that page deliberately inline it. */
function page(root: string, items: unknown[]): Record<string, unknown> {
  return { data: { [root]: { items, pageInfo: { hasNextPage: false, endCursor: null } } } };
}

/** Serve a fixed sequence of GraphQL bodies; `/ready` always 200. */
function scriptedFetch(pages: Array<Record<string, unknown>>) {
  let i = 0;
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    if (isReadyProbe(String(url))) return new Response('ok', { status: 200 });
    return new Response(JSON.stringify(pages[i++] ?? { data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function readerWith(
  fetchImpl: unknown,
  overrides: Partial<HttpDiscoveryClientOptions> = {},
): TaskLifecycleReader {
  return createTaskLifecycleReader({
    url: 'http://stub/graphql',
    fetchImpl: fetchImpl as typeof fetch,
    ...overrides,
  });
}

const TASK_ROW = {
  id: '7', chainId: 84532, manifestDigest: hex32('11'), taskCidDigest: hex32('22'),
  creator: addr('aa'), maxClaims: 2, requiredVerdicts: 1, createdAtBlock: '10',
  createdAtTx: hex32('77'), finalized: false, refunded: false,
};
const TASK_PAGE = page('tasks', [TASK_ROW]);

describe('createTaskLifecycleReader.getTaskLifecycleEvidence (#2044)', () => {
  it('short-circuits an empty task list with no network I/O', async () => {
    const fetchImpl = vi.fn();
    await expect(readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: [] }))
      .resolves.toEqual(new Map());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns an ordered spine with identity, request-ID and block facts, and attaches both envelope publishers (AC1)', async () => {
    const fetchImpl = scriptedFetch([
      TASK_PAGE,
      // attempts — deliberately reverse-ordered in the payload
      page('attempts', [
        { taskId: '7', chainId: 84532, attemptIndex: 1, requestId: hex32('b1'),
          operator: addr('b1'), priorityMech: addr('c1'), deliveryRate: '2', createdAtBlock: '21' },
        { taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
          operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: '20' },
      ]),
      // verdicts — also reverse-ordered
      page('verdicts', [
        { taskId: '7', chainId: 84532, attemptIndex: 0, verdictIndex: 1, requestId: hex32('d1'),
          evaluator: addr('e1'), verdictCode: 2, createdAtBlock: '31' },
        { taskId: '7', chainId: 84532, attemptIndex: 0, verdictIndex: 0, requestId: hex32('d0'),
          evaluator: addr('e0'), verdictCode: 1, createdAtBlock: '30' },
      ]),
      // attemptEnvelopeMetas — two publishers for the same SOLVE request
      page('attemptEnvelopeMetas', [
        { requestId: hex32('b0'), chainId: 84532, manifestCid: 'bafy1', publisherAgentId: '1',
          manifestHash: hex32('01'), enrichedAtBlock: '25', solverType: 'prediction.v0' },
        { requestId: hex32('b0'), chainId: 84532, manifestCid: 'bafy2', publisherAgentId: '2',
          manifestHash: hex32('02'), enrichedAtBlock: '26' },
      ]),
      page('verdictEnvelopeMetas', [
        { requestId: hex32('d0'), chainId: 84532, manifestCid: 'bafyV', publisherAgentId: '9',
          manifestHash: hex32('09'), enrichedAtBlock: '35', actualPassed: true },
      ]),
    ]);
    const map = await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7', 'missing'] });

    expect(map.has('missing')).toBe(false);
    const ev = map.get('7')!;
    // Task facts (AC1)
    expect(ev.authoritative.task.creator).toBe(addr('aa'));
    expect(ev.authoritative.task.taskCidDigest).toBe(hex32('22'));
    expect(ev.authoritative.task.createdAtBlock).toBe(10);
    expect(ev.authoritative.task.createdAtTx).toBe(hex32('77'));
    expect(ev.authoritative.task.chainId).toBe(84532);
    // Ordering is lossless regardless of payload order (AC2)
    expect(ev.authoritative.attempts.map((a) => a.attemptIndex)).toEqual([0, 1]);
    expect(ev.authoritative.attempts[0]!.verdicts.map((v) => v.verdictIndex)).toEqual([0, 1]);
    // Request-ID identity: SOLVE on the attempt, EVAL on the verdict (AC1)
    expect(ev.authoritative.attempts[0]!.requestId).toBe(hex32('b0'));
    expect(ev.authoritative.attempts[0]!.verdicts[0]!.requestId).toBe(hex32('d0'));
    expect(ev.authoritative.attempts[0]!.verdicts[0]!.verdictCode).toBe(1);
    expect(ev.authoritative.attempts[0]!.verdicts[1]!.verdictCode).toBe(2);
    // Candidate envelopes (AC1) — every publisher retained
    expect(ev.authoritative.attempts[0]!.attemptEnvelopeCandidates
      .map((c) => c.publisherAgentId)).toEqual(['1', '2']);
    expect(ev.authoritative.attempts[0]!.attemptEnvelopeCandidates[0]!.solverType)
      .toBe('prediction.v0');
    expect(ev.authoritative.attempts[0]!.verdicts[0]!.verdictEnvelopeCandidates[0]!.actualPassed)
      .toBe(true);
  });

  it('renames verdict-envelope spine-shaped columns to projected* on ingest (AC3)', async () => {
    const fetchImpl = scriptedFetch([
      TASK_PAGE,
      page('attempts', [
        { taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
          operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: '20' },
      ]),
      page('verdicts', [
        { taskId: '7', chainId: 84532, attemptIndex: 0, verdictIndex: 0, requestId: hex32('d0'),
          evaluator: addr('e0'), verdictCode: 1, createdAtBlock: '30' },
      ]),
      page('attemptEnvelopeMetas', []),
      // The indexer's own projection CONTRADICTS the spine on all four columns.
      page('verdictEnvelopeMetas', [
        { requestId: hex32('d0'), chainId: 84532, manifestCid: 'bafyV', publisherAgentId: '9',
          manifestHash: hex32('09'), enrichedAtBlock: '35',
          taskId: '999', attemptIndex: 99, verdictIndex: 99, evaluator: addr('ff') },
      ]),
    ]);
    const verdict = (await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] }))
      .get('7')!.authoritative.attempts[0]!.verdicts[0]!;

    // The spine is untouched by the contradiction.
    expect(verdict.taskId).toBe('7');
    expect(verdict.attemptIndex).toBe(0);
    expect(verdict.verdictIndex).toBe(0);
    expect(verdict.evaluator).toBe(addr('e0'));

    // The candidate carries the indexer's values ONLY under projected* names —
    // the spine-shaped keys are absent from the object, not merely unread.
    const cand = verdict.verdictEnvelopeCandidates[0]!;
    expect(cand.projectedTaskId).toBe('999');
    expect(cand.projectedAttemptIndex).toBe(99);
    expect(cand.projectedVerdictIndex).toBe(99);
    expect(cand.projectedEvaluator).toBe(addr('ff'));
    expect(Object.keys(cand)).not.toContain('taskId');
    expect(Object.keys(cand)).not.toContain('attemptIndex');
    expect(Object.keys(cand)).not.toContain('verdictIndex');
    expect(Object.keys(cand)).not.toContain('evaluator');
  });

  it('queries no downstream leg when the tasks leg comes back empty', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (isReadyProbe(String(url))) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify(page('tasks', [])), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    expect((await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).size).toBe(0);
    // Only the tasks leg ran; a task-less result never queries the meta legs.
    const gqlCalls = fetchImpl.mock.calls.filter(([u]) => !isReadyProbe(String(u)));
    expect(gqlCalls).toHaveLength(1);
  });

  it('never lets a candidate-only projection invent a spine (AC3)', async () => {
    // The candidate leg genuinely runs here: one attempt supplies the
    // requestId_in filter, and the leg answers with a candidate for a
    // requestId no spine row carries.
    const fetchImpl = scriptedFetch([
      TASK_PAGE,
      page('attempts', [
        { taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
          operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: '20' },
      ]),
      page('verdicts', []),
      page('attemptEnvelopeMetas', [
        // Belongs to the spine attempt.
        { requestId: hex32('b0'), chainId: 84532, manifestCid: 'bafy1', publisherAgentId: '1',
          manifestHash: hex32('01'), enrichedAtBlock: '25' },
        // Belongs to nothing — an attempt this read never saw.
        { requestId: hex32('bf'), chainId: 84532, manifestCid: 'bafyGhost', publisherAgentId: '9',
          manifestHash: hex32('0f'), enrichedAtBlock: '26' },
      ]),
    ]);
    const ev = (await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).get('7')!;
    // The orphan candidate did not become a second attempt.
    expect(ev.authoritative.attempts).toHaveLength(1);
    expect(ev.authoritative.attempts[0]!.attemptEnvelopeCandidates.map((c) => c.manifestCid))
      .toEqual(['bafy1']);
  });

  it('does not attach an attempt row from a different chain to the spine (AC3)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = scriptedFetch([
      TASK_PAGE, // task 7 lives on chain 84532
      // An indexer that ignored the chainId filter returns a chain-8453 row.
      page('attempts', [
        { taskId: '7', chainId: 8453, attemptIndex: 0, requestId: hex32('b9'),
          operator: addr('b9'), priorityMech: addr('c9'), deliveryRate: '9', createdAtBlock: '99' },
      ]),
      page('verdicts', []),
    ]);
    const ev = (await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).get('7')!;
    expect(ev.authoritative.attempts).toEqual([]);
    // Out of scope, but never silent.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped attempts row(s)'));
    warn.mockRestore();
  });

  it('withdraws the whole read when a task row is unparseable (absence > partial lie)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = scriptedFetch([
      page('tasks', [{ ...TASK_ROW, creator: '0xnope' }]),
    ]);
    expect((await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unusable tasks row (taskId=7)'));
    // The malformed row aborts before any downstream leg is queried.
    expect(fetchImpl.mock.calls.filter(([u]) => !isReadyProbe(String(u)))).toHaveLength(1);
    warn.mockRestore();
  });

  it('withdraws the whole read when an attempt index is not a safe integer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = scriptedFetch([
      TASK_PAGE,
      page('attempts', [
        // A fractional index would key and sort the spine on garbage.
        { taskId: '7', chainId: 84532, attemptIndex: 1.5, requestId: hex32('b0'),
          operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: '20' },
      ]),
    ]);
    expect((await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unusable attempts row (taskId=7 attemptIndex=1.5)'),
    );
    warn.mockRestore();
  });

  it('withdraws the whole read when a verdict row is unparseable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = scriptedFetch([
      TASK_PAGE,
      page('attempts', [
        { taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
          operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: '20' },
      ]),
      page('verdicts', [
        { taskId: '7', chainId: 84532, attemptIndex: 0, verdictIndex: -1, requestId: hex32('d0'),
          evaluator: addr('e0'), verdictCode: 1, createdAtBlock: '30' },
      ]),
    ]);
    expect((await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unusable verdicts row'));
    warn.mockRestore();
  });

  it('omits a task the caller never asked for', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = scriptedFetch([
      // A leaky `id_in` also returns task 8.
      page('tasks', [TASK_ROW, { ...TASK_ROW, id: '8' }]),
      page('attempts', []),
      page('verdicts', []),
    ]);
    const map = await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] });
    expect([...map.keys()]).toEqual(['7']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped tasks row(s)'));
    warn.mockRestore();
  });

  it('attaches a leaked cross-chain verdict once, not once per chain pass', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chainBVerdict = {
      taskId: '8', chainId: 8453, attemptIndex: 0, verdictIndex: 0, requestId: hex32('d8'),
      evaluator: addr('e8'), verdictCode: 1, createdAtBlock: '40',
    };
    const fetchImpl = scriptedFetch([
      page('tasks', [TASK_ROW, { ...TASK_ROW, id: '8', chainId: 8453 }]),
      page('attempts', [
        { taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
          operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: '20' },
      ]),
      page('attempts', [
        { taskId: '8', chainId: 8453, attemptIndex: 0, requestId: hex32('b8'),
          operator: addr('b8'), priorityMech: addr('c8'), deliveryRate: '1', createdAtBlock: '30' },
      ]),
      // The chain-84532 pass leaks the chain-8453 row; the chain-8453 pass
      // returns it legitimately.
      page('verdicts', [chainBVerdict]),
      page('verdicts', [chainBVerdict]),
      page('attemptEnvelopeMetas', []),
      page('verdictEnvelopeMetas', []),
    ]);
    const map = await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7', '8'] });
    expect(map.get('8')!.authoritative.attempts[0]!.verdicts.map((v) => v.verdictIndex))
      .toEqual([0]);
    expect(map.get('7')!.authoritative.attempts[0]!.verdicts).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped verdicts row(s)'));
    warn.mockRestore();
  });

  it('skips an unparseable candidate row without withdrawing the spine', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = scriptedFetch([
      TASK_PAGE,
      page('attempts', [
        { taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
          operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: '20' },
      ]),
      page('verdicts', []),
      page('attemptEnvelopeMetas', [
        // Two unusable candidate rows: one bad chainId, one bad hash. The leg
        // warns once, not twice.
        { requestId: hex32('b0'), chainId: 1.5, manifestCid: 'bafy1', publisherAgentId: '1',
          manifestHash: hex32('01'), enrichedAtBlock: '25' },
        { requestId: hex32('b0'), chainId: 84532, manifestCid: 'bafy2', publisherAgentId: '2',
          manifestHash: 'not-hex', enrichedAtBlock: '26' },
        { requestId: hex32('b0'), chainId: 84532, manifestCid: 'bafy3', publisherAgentId: '3',
          manifestHash: hex32('03'), enrichedAtBlock: '27' },
      ]),
    ]);
    const attempt = (await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] }))
      .get('7')!.authoritative.attempts[0]!;
    // The spine survives; only the good candidate attaches.
    expect(attempt.attemptEnvelopeCandidates.map((c) => c.publisherAgentId)).toEqual(['3']);
    const skips = warn.mock.calls
      .filter(([m]) => String(m).includes('skipped attemptEnvelopeMetas row(s)'));
    expect(skips).toHaveLength(1);
    warn.mockRestore();
  });

  it('scopes the attempt and verdict legs by the chainId of the task row', async () => {
    const fetchImpl = scriptedFetch([TASK_PAGE, page('attempts', []), page('verdicts', [])]);
    await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] });
    const bodies = fetchImpl.mock.calls
      .filter(([u]) => !isReadyProbe(String(u)))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    // No caller-supplied chainId: it is derived from the task row itself.
    expect(bodies[0]!.variables).toEqual({ taskIds: ['7'], limit: 1000, after: null });
    expect(bodies[1]!.variables.chainId).toBe(84532);
    expect(bodies[2]!.variables.chainId).toBe(84532);
  });

  it('returns an empty Map when a leg hits the page cap (absence > partial lie)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (isReadyProbe(String(url))) return new Response('ok', { status: 200 });
      // Always claim another page so the 50-page hard cap binds on the tasks leg.
      return new Response(JSON.stringify({
        data: { tasks: { items: [TASK_ROW], pageInfo: { hasNextPage: true, endCursor: 'next' } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    expect((await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).size).toBe(0);
    const gqlCalls = fetchImpl.mock.calls.filter(([u]) => !isReadyProbe(String(u)));
    expect(gqlCalls).toHaveLength(50);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('page cap hit on tasks'));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('propagates an unready indexer as DiscoveryUnavailableError', async () => {
    const fetchImpl = vi.fn(async () => new Response('syncing', { status: 503 }));
    // No backoff sleep in tests.
    const reader = readerWith(fetchImpl, { retryDelaysMs: [] });
    await expect(reader.getTaskLifecycleEvidence({ taskIds: ['7'] }))
      .rejects.toThrow(/indexer not ready/u);
  });

  it('queries no leg when every requested task id is blank', async () => {
    // `.filter(Boolean)` empties the requested set, and an empty `id_in` would
    // match the WHOLE task table. The `/ready` probe still runs — the zero-I/O
    // short-circuit is the `taskIds.length === 0` case above, and this one
    // lands after it.
    const fetchImpl = scriptedFetch([]);
    await expect(readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['', ''] }))
      .resolves.toEqual(new Map());
    expect(fetchImpl.mock.calls.filter(([u]) => !isReadyProbe(String(u)))).toHaveLength(0);
  });

  it('withdraws the read when a verdict names an attempt the spine never saw', async () => {
    // Reachable in production: five separate unpinned reads, so the indexer can
    // index an attempt after the attempts leg ran and still answer with its
    // verdict. The result carries no asOfBlock marker, so the caller could
    // never detect the missing verdict.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = scriptedFetch([
      TASK_PAGE,
      page('attempts', [
        { taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
          operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: '20' },
      ]),
      page('verdicts', [
        { taskId: '7', chainId: 84532, attemptIndex: 1, verdictIndex: 0, requestId: hex32('d1'),
          evaluator: addr('e0'), verdictCode: 1, createdAtBlock: '31' },
      ]),
      page('attemptEnvelopeMetas', []),
      page('verdictEnvelopeMetas', []),
    ]);
    expect((await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unusable verdicts row (taskId=7 attemptIndex=1'),
    );
    warn.mockRestore();
  });

  it('preserves deliveryRate as an exact wei string', async () => {
    // Wei past Number.MAX_SAFE_INTEGER: anything that routed this through a
    // number would round it.
    const wei = '123456789012345678901';
    const fetchImpl = scriptedFetch([
      TASK_PAGE,
      page('attempts', [
        { taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
          operator: addr('b0'), priorityMech: addr('c0'),
          deliveryRate: wei, createdAtBlock: '20' },
      ]),
      page('verdicts', []),
      page('attemptEnvelopeMetas', []),
    ]);
    const ev = (await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).get('7')!;
    expect(ev.authoritative.attempts[0]!.deliveryRate).toBe(wei);
  });

  it('withdraws the read when deliveryRate is not a string or number', async () => {
    // `String(null)` would put the literal "null" into the spine.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = scriptedFetch([
      TASK_PAGE,
      page('attempts', [
        { taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
          operator: addr('b0'), priorityMech: addr('c0'),
          deliveryRate: null, createdAtBlock: '20' },
      ]),
    ]);
    expect((await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unusable attempts row'));
    warn.mockRestore();
  });

  it('withdraws the read when createdAtTx is malformed rather than omitting the field', async () => {
    // The identity a consumer re-derives the task against an RPC with. Failing
    // OPEN here would drop it silently on the same row where a bad `creator`
    // withdraws the read.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = scriptedFetch([page('tasks', [{ ...TASK_ROW, createdAtTx: '0xnope' }])]);
    expect((await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unusable tasks row (taskId=7)'));
    warn.mockRestore();
  });

  it('withdraws the read when verdictCode is outside the documented 0..4 enum', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = scriptedFetch([
      TASK_PAGE,
      page('attempts', [
        { taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
          operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: '20' },
      ]),
      page('verdicts', [
        { taskId: '7', chainId: 84532, attemptIndex: 0, verdictIndex: 0, requestId: hex32('d0'),
          evaluator: addr('e0'), verdictCode: 999, createdAtBlock: '30' },
      ]),
    ]);
    expect((await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unusable verdicts row'));
    warn.mockRestore();
  });

  it("keeps a candidate whose manifestHash is the schema default '0x'", async () => {
    // `t.hex().notNull().default('0x')` — the loose hex check exists to ADMIT
    // these rows. A `+` quantifier rejected every one of them.
    const fetchImpl = scriptedFetch([
      TASK_PAGE,
      page('attempts', [
        { taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
          operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: '20' },
      ]),
      page('verdicts', []),
      page('attemptEnvelopeMetas', [
        { requestId: hex32('b0'), chainId: 84532, manifestCid: 'bafy1', publisherAgentId: '1',
          manifestHash: '0x', enrichedAtBlock: '25' },
      ]),
    ]);
    const ev = (await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).get('7')!;
    const candidates = ev.authoritative.attempts[0]!.attemptEnvelopeCandidates;
    expect(candidates.map((c) => c.manifestHash)).toEqual(['0x']);
  });

  it('withdraws a leg whose connection root field is missing', async () => {
    // `200 {"data":{}}` used to read as an empty leg, indistinguishable from a
    // leg that genuinely holds nothing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (isReadyProbe(String(url))) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ data: {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    expect((await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('missing or malformed connection on tasks'),
    );
    warn.mockRestore();
  });

  it('withdraws a leg whose items is not an array, instead of throwing', async () => {
    // The raw spread threw a TypeError that escaped the documented
    // DiscoveryUnavailableError contract.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (isReadyProbe(String(url))) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ data: { tasks: { items: 'nope' } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    await expect(readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] }))
      .resolves.toEqual(new Map());
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('missing or malformed connection on tasks'),
    );
    warn.mockRestore();
  });

  it('withdraws a full page that carries no pageInfo (absence > partial lie)', async () => {
    // A FULL page with no pageInfo is not "the last page" — the page cap can
    // never engage, so a truncated leg is presented as the whole answer.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (isReadyProbe(String(url))) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ data: { tasks: { items: [TASK_ROW] } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    expect((await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('missing or malformed pageInfo on tasks'),
    );
    warn.mockRestore();
  });

  it('withdraws an announced next page that comes back empty and pageInfo-less', async () => {
    // The empty-page twin of the case above. Page 0 announces another page, so
    // absence on page 1 is not evidence the leg is complete — without the
    // first-page gate the reader handed back page 0 as the whole answer.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = scriptedFetch([
      { data: { tasks: { items: [TASK_ROW], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } },
      { data: { tasks: { items: [] } } },
    ]);
    expect((await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('missing or malformed pageInfo on tasks'),
    );
    warn.mockRestore();
  });

  it('batches an oversized taskIds filter instead of sending one giant variable', async () => {
    const taskIds = Array.from({ length: 600 }, (_, i) => String(i));
    const fetchImpl = scriptedFetch([page('tasks', []), page('tasks', [])]);
    await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds });
    const bodies = fetchImpl.mock.calls
      .filter(([u]) => !isReadyProbe(String(u)))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies.map((b) => b.variables.taskIds.length)).toEqual([500, 100]);
  });

  it('batches an oversized requestId_in filter on the candidate legs', async () => {
    // 501 attempts on one task means 501 distinct 66-char SOLVE requestIds —
    // ~34 KB of ids per 500, and unbatched the whole set rode in one variable.
    const attemptRows = Array.from({ length: 501 }, (_, i) => ({
      taskId: '7', chainId: 84532, attemptIndex: i,
      requestId: `0x${String(i).padStart(64, '0')}`,
      operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: '20',
    }));
    const fetchImpl = scriptedFetch([
      TASK_PAGE,
      page('attempts', attemptRows),
      page('verdicts', []),
      page('attemptEnvelopeMetas', []),
      page('attemptEnvelopeMetas', []),
    ]);
    await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] });
    const metaBodies = fetchImpl.mock.calls
      .filter(([u]) => !isReadyProbe(String(u)))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
      .filter((b) => b.query.includes('attemptEnvelopeMetas('));
    expect(metaBodies.map((b) => b.variables.requestIds.length)).toEqual([500, 1]);
  });

  it('withdraws the whole read when one batch of a batched leg is undrainable', async () => {
    // The batches merge into one leg, so a batch that cannot be drained is a
    // hole in that leg — handing back the batches that did drain would present
    // a truncated candidate set as the complete one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const attemptRows = Array.from({ length: 501 }, (_, i) => ({
      taskId: '7', chainId: 84532, attemptIndex: i,
      requestId: `0x${String(i).padStart(64, '0')}`,
      operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: '20',
    }));
    const fetchImpl = scriptedFetch([
      TASK_PAGE,
      page('attempts', attemptRows),
      page('verdicts', []),
      page('attemptEnvelopeMetas', [
        { requestId: `0x${'0'.repeat(64)}`, chainId: 84532, manifestCid: 'bafy1',
          publisherAgentId: '1', manifestHash: hex32('01'), enrichedAtBlock: '25' },
      ]),
      // Second batch: a connection-less body, the undrainable shape.
      { data: {} },
    ]);
    expect((await readerWith(fetchImpl).getTaskLifecycleEvidence({ taskIds: ['7'] })).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('missing or malformed connection on attemptEnvelopeMetas'),
    );
    warn.mockRestore();
  });
});
