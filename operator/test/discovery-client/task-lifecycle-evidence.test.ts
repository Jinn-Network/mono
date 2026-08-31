/**
 * Pure-assembler tests for task lifecycle evidence (#2044).
 *
 * The invariant under test: the authoritative spine is built ONLY from
 * task/attempt/verdict rows. Envelope candidates attach last, joined by
 * (requestId, chainId), and can never create or rewrite a spine row.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  assembleTaskLifecycleEvidence,
  type RawAttemptRow,
  type RawTaskRow,
  type RawVerdictRow,
} from '../../src/discovery-client/task-lifecycle-evidence.js';

const hex32 = (n: string) => `0x${n.repeat(32)}` as `0x${string}`;
const addr = (n: string) => `0x${n.repeat(20)}` as `0x${string}`;

const CHAIN = 84532;

// Row builders. Anything a test asserts on or varies is passed as an override
// at the call site, so a failure still points at the value that caused it;
// only inert identity fields live in the defaults.

function task(overrides: Partial<RawTaskRow> = {}): RawTaskRow {
  return {
    taskId: '7',
    chainId: CHAIN,
    manifestDigest: hex32('11'),
    taskCidDigest: hex32('22'),
    creator: addr('aa'),
    maxClaims: 1,
    requiredVerdicts: 1,
    createdAtBlock: 10,
    createdAtTx: hex32('77'),
    finalized: false,
    refunded: false,
    ...overrides,
  };
}

function attempt(overrides: Partial<RawAttemptRow> = {}): RawAttemptRow {
  return {
    taskId: '7',
    chainId: CHAIN,
    attemptIndex: 0,
    requestId: hex32('b0'),
    operator: addr('b0'),
    priorityMech: addr('c0'),
    deliveryRate: '1',
    createdAtBlock: 20,
    ...overrides,
  };
}

function verdict(overrides: Partial<RawVerdictRow> = {}): RawVerdictRow {
  return {
    taskId: '7',
    chainId: CHAIN,
    attemptIndex: 0,
    verdictIndex: 0,
    requestId: hex32('d0'),
    evaluator: addr('e0'),
    verdictCode: 1,
    createdAtBlock: 30,
    ...overrides,
  };
}

describe('assembleTaskLifecycleEvidence (#2044)', () => {
  it('nests and sorts multiple attempts and verdicts losslessly (AC2)', () => {
    const map = assembleTaskLifecycleEvidence({
      tasks: [task({ maxClaims: 2 })],
      // Both lists are deliberately out of index order.
      attempts: [
        attempt({ attemptIndex: 1, requestId: hex32('b1'), createdAtBlock: 21 }),
        attempt({ attemptIndex: 0, requestId: hex32('b0'), createdAtBlock: 20 }),
      ],
      verdicts: [
        verdict({ attemptIndex: 0, verdictIndex: 1, requestId: hex32('d1'), verdictCode: 2 }),
        verdict({ attemptIndex: 0, verdictIndex: 0, requestId: hex32('d0'), verdictCode: 1 }),
        verdict({ attemptIndex: 1, verdictIndex: 0, requestId: hex32('d2'), verdictCode: 1 }),
      ],
    });
    const ev = map.get('7')!;
    expect(ev.authoritative.attempts.map((a) => a.attemptIndex)).toEqual([0, 1]);
    expect(ev.authoritative.attempts[0]!.verdicts.map((v) => v.verdictIndex)).toEqual([0, 1]);
    expect(ev.authoritative.attempts[1]!.verdicts.map((v) => v.verdictIndex)).toEqual([0]);
    // The SOLVE request and the EVAL request are distinct identities, both kept.
    expect(ev.authoritative.attempts[0]!.requestId).toBe(hex32('b0'));
    expect(ev.authoritative.attempts[0]!.verdicts[0]!.requestId).toBe(hex32('d0'));
    expect(ev.authoritative.attempts[0]!.verdicts[1]!.verdictCode).toBe(2);
  });

  it('withdraws the read when a verdict has no attempt row (absence > partial lie)', () => {
    // The live case: the five legs are separate unpinned reads, so the indexer
    // can index an attempt AFTER the attempts leg ran and still return its
    // verdict on the verdicts leg. Keeping the spine would hand the caller a
    // task that looks complete and is missing a real verdict, with nothing in
    // the result saying so.
    const onUnplaceableRow = vi.fn();
    const map = assembleTaskLifecycleEvidence({
      tasks: [task()],
      attempts: [attempt({ attemptIndex: 0 })],
      // No attempt 9 exists on the spine.
      verdicts: [verdict({ attemptIndex: 9, requestId: hex32('d9') })],
      onUnplaceableRow,
    });
    expect(map.size).toBe(0);
    expect(onUnplaceableRow).toHaveBeenCalledWith(
      'verdicts',
      expect.stringContaining('attemptIndex=9'),
    );
  });

  it('withdraws the read when an attempt has no task row', () => {
    const onUnplaceableRow = vi.fn();
    const map = assembleTaskLifecycleEvidence({
      tasks: [task({ taskId: '7' })],
      attempts: [attempt({ taskId: '8' })],
      verdicts: [],
      onUnplaceableRow,
    });
    expect(map.size).toBe(0);
    expect(onUnplaceableRow).toHaveBeenCalledWith(
      'attempts',
      expect.stringContaining('taskId=8'),
    );
  });

  it('withdraws the read when an attempt contradicts its task on chainId', () => {
    // `out` is keyed by taskId ALONE, so without this check a chain-8453
    // attempt attaches to an 84532 task and the spine claims a cross-chain
    // lifecycle that does not exist.
    const onUnplaceableRow = vi.fn();
    const map = assembleTaskLifecycleEvidence({
      tasks: [task({ chainId: 84532 })],
      attempts: [attempt({ chainId: 8453 })],
      verdicts: [],
      onUnplaceableRow,
    });
    expect(map.size).toBe(0);
    expect(onUnplaceableRow).toHaveBeenCalledWith(
      'attempts',
      expect.stringContaining('chainId=8453'),
    );
  });

  it('leaves every non-identity authoritative field byte-identical after a contradictory candidate attaches (AC3)', () => {
    // The half no type can catch: the AC3 type block only forbids a candidate
    // from DECLARING a spine identity column. An assignment that copies a
    // differently-named candidate field over an authoritative one
    // (`v.verdictCode = c.projectedVerdictIndex`) compiles clean, so the
    // guarantee has to be asserted behaviorally.
    const taskRow = task({ creator: addr('aa'), createdAtBlock: 10 });
    const attemptRow = attempt({ deliveryRate: '123456789012345678', requestId: hex32('b0') });
    const verdictRow = verdict({ verdictCode: 3, requestId: hex32('d0') });
    const map = assembleTaskLifecycleEvidence({
      tasks: [taskRow],
      attempts: [attemptRow],
      verdicts: [verdictRow],
      attemptCandidates: [{
        requestId: hex32('b0'), chainId: CHAIN, manifestCid: 'bafyA',
        publisherAgentId: '1', manifestHash: hex32('99'), enrichedAtBlock: 25,
      }],
      verdictCandidates: [{
        requestId: hex32('d0'), chainId: CHAIN, manifestCid: 'bafyV',
        publisherAgentId: '2', manifestHash: hex32('88'), enrichedAtBlock: 35,
        projectedTaskId: '999', projectedAttemptIndex: 99, projectedVerdictIndex: 99,
        projectedEvaluator: addr('ff'), actualPassed: true, actualScore: '0.0',
      }],
    });
    const ev = map.get('7')!;
    expect(ev.authoritative.task.creator).toBe(taskRow.creator);
    expect(ev.authoritative.task.createdAtBlock).toBe(taskRow.createdAtBlock);
    expect(ev.authoritative.task.createdAtTx).toBe(taskRow.createdAtTx);
    const a = ev.authoritative.attempts[0]!;
    expect(a.deliveryRate).toBe(attemptRow.deliveryRate);
    expect(a.createdAtBlock).toBe(attemptRow.createdAtBlock);
    expect(a.priorityMech).toBe(attemptRow.priorityMech);
    const v = a.verdicts[0]!;
    expect(v.verdictCode).toBe(verdictRow.verdictCode);
    expect(v.createdAtBlock).toBe(verdictRow.createdAtBlock);
    // …and the candidates really did attach, so the assertions above are not
    // passing vacuously.
    expect(a.attemptEnvelopeCandidates).toHaveLength(1);
    expect(v.verdictEnvelopeCandidates).toHaveLength(1);
  });

  it('attaches candidates by requestId+chainId without rewriting spine fields (AC3)', () => {
    const map = assembleTaskLifecycleEvidence({
      tasks: [task()],
      attempts: [attempt({ requestId: hex32('b0'), operator: addr('b0') })],
      verdicts: [verdict({ requestId: hex32('d0'), evaluator: addr('e0') })],
      attemptCandidates: [{
        requestId: hex32('b0'), chainId: CHAIN, manifestCid: 'bafyA',
        publisherAgentId: '1', manifestHash: hex32('99'), enrichedAtBlock: 25,
      }],
      verdictCandidates: [{
        requestId: hex32('d0'), chainId: CHAIN, manifestCid: 'bafyV',
        publisherAgentId: '2', manifestHash: hex32('88'), enrichedAtBlock: 35,
        projectedTaskId: '999', projectedAttemptIndex: 99, projectedVerdictIndex: 99,
        projectedEvaluator: addr('ff'), solutionRequestId: 'hint-only',
      }],
    });
    const spineAttempt = map.get('7')!.authoritative.attempts[0]!;
    // Spine identity survives a contradictory candidate verbatim.
    expect(spineAttempt.taskId).toBe('7');
    expect(spineAttempt.attemptIndex).toBe(0);
    expect(spineAttempt.operator).toBe(addr('b0'));
    expect(spineAttempt.attemptEnvelopeCandidates).toHaveLength(1);
    const spineVerdict = spineAttempt.verdicts[0]!;
    expect(spineVerdict.taskId).toBe('7');
    expect(spineVerdict.attemptIndex).toBe(0);
    expect(spineVerdict.verdictIndex).toBe(0);
    expect(spineVerdict.evaluator).toBe(addr('e0'));
    // The contradictory values are readable, but only under projected* names.
    expect(spineVerdict.verdictEnvelopeCandidates[0]!.projectedTaskId).toBe('999');
    expect(spineVerdict.verdictEnvelopeCandidates[0]!.projectedEvaluator).toBe(addr('ff'));
  });

  it('does not attach a candidate whose chainId differs from the spine row (AC3)', () => {
    const map = assembleTaskLifecycleEvidence({
      tasks: [task()],
      attempts: [attempt({ requestId: hex32('b0') })],
      verdicts: [],
      attemptCandidates: [{
        // Same requestId, different chain.
        requestId: hex32('b0'), chainId: 8453, manifestCid: 'bafyOtherChain',
        publisherAgentId: '1', manifestHash: hex32('99'), enrichedAtBlock: 25,
      }],
    });
    expect(map.get('7')!.authoritative.attempts[0]!.attemptEnvelopeCandidates).toEqual([]);
  });

  it('never invents a spine row from candidates alone (AC3)', () => {
    const map = assembleTaskLifecycleEvidence({
      tasks: [],
      attempts: [],
      verdicts: [],
      attemptCandidates: [
        { requestId: hex32('b0'), chainId: CHAIN, manifestCid: 'bafy1',
          publisherAgentId: '1', manifestHash: hex32('01'), enrichedAtBlock: 1 },
        { requestId: hex32('b0'), chainId: CHAIN, manifestCid: 'bafy2',
          publisherAgentId: '2', manifestHash: hex32('02'), enrichedAtBlock: 2 },
      ],
      verdictCandidates: [
        { requestId: hex32('d0'), chainId: CHAIN, manifestCid: 'bafyV',
          publisherAgentId: '3', manifestHash: hex32('03'), enrichedAtBlock: 3,
          projectedTaskId: '7', projectedAttemptIndex: 0, projectedVerdictIndex: 0 },
      ],
    });
    expect(map.size).toBe(0);
  });

  it('retains every candidate publisher for one request (AC1)', () => {
    const map = assembleTaskLifecycleEvidence({
      tasks: [task()],
      attempts: [attempt({ requestId: hex32('b0') })],
      verdicts: [],
      attemptCandidates: [
        { requestId: hex32('b0'), chainId: CHAIN, manifestCid: 'bafy1',
          publisherAgentId: '1', manifestHash: hex32('01'), enrichedAtBlock: 1 },
        { requestId: hex32('b0'), chainId: CHAIN, manifestCid: 'bafy2',
          publisherAgentId: '2', manifestHash: hex32('02'), enrichedAtBlock: 2 },
      ],
    });
    expect(map.get('7')!.authoritative.attempts[0]!.attemptEnvelopeCandidates
      .map((c) => c.publisherAgentId)).toEqual(['1', '2']);
  });
});
