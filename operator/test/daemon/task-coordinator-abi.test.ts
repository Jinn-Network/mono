/**
 * `TaskCoordinator.getTask` decode offsets (#4286).
 *
 * `composition-root.ts` used to declare its own `GET_TASK_VIEW_ABI` with `policy` as a `uint8`.
 * The deployed contract returns it as a nested `(uint32 maxClaims, bool
 * allowSolverSelfEvaluation)` tuple, which occupies TWO head words -- so every field after
 * `policy` read one word early and `creatorCredited` was truthy for any non-zero
 * `finalizedAttemptCount`. All components are static, so viem decoded 9 of the 10 words without
 * throwing: silently wrong, no error. These tests decode a fixed on-chain payload through the
 * shared `TASK_COORDINATOR_ABI` slice the call site now consumes and pin the fields after `policy`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Abi, decodeFunctionResult, encodeAbiParameters, getAbiItem, type Hex } from 'viem';
import { TASK_COORDINATOR_ABI } from '@jinn-network/marketplace-binding';

const RECORD = {
  creator: '0x00000000000000000000000000000000000000A1',
  taskCidDigest: `0x${'11'.repeat(32)}`,
  manifestDigest: `0x${'22'.repeat(32)}`,
  status: 2,
  policy: { maxClaims: 5, allowSolverSelfEvaluation: true },
  claimCount: 4,
  submittedCount: 3,
  finalizedAttemptCount: 1,
  creatorCredited: false,
} as const;

const word = (hex: string) => hex.padStart(64, '0');

/**
 * `getTask`'s return as the contract lays it out: ten static head words, `policy` spanning words
 * 4 and 5. Written out by hand rather than encoded from the ABI under test, so the decode below
 * proves the declaration against a fixed layout instead of against itself.
 */
const PAYLOAD: Hex = `0x${[
  word('a1'), // creator
  '11'.repeat(32), // taskCidDigest
  '22'.repeat(32), // manifestDigest
  word('2'), // status
  word('5'), // policy.maxClaims
  word('1'), // policy.allowSolverSelfEvaluation
  word('4'), // claimCount
  word('3'), // submittedCount
  word('1'), // finalizedAttemptCount
  word('0'), // creatorCredited
].join('')}`;

const getTaskOutputs = getAbiItem({ abi: TASK_COORDINATOR_ABI, name: 'getTask' }).outputs;

/** The deleted `composition-root.ts` literal, kept here only as the known-bad control. */
const OLD_GET_TASK_VIEW_ABI = [
  {
    type: 'function',
    name: 'getTask',
    stateMutability: 'view',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [
      {
        name: 'task',
        type: 'tuple',
        components: [
          { name: 'creator', type: 'address' },
          { name: 'taskCidDigest', type: 'bytes32' },
          { name: 'manifestDigest', type: 'bytes32' },
          { name: 'status', type: 'uint8' },
          { name: 'policy', type: 'uint8' },
          { name: 'claimCount', type: 'uint32' },
          { name: 'submittedCount', type: 'uint32' },
          { name: 'finalizedAttemptCount', type: 'uint32' },
          { name: 'creatorCredited', type: 'bool' },
        ],
      },
    ],
  },
] as const satisfies Abi;

const compositionRoot = readFileSync(
  resolve(fileURLToPath(new URL('.', import.meta.url)), '../../src/daemon/composition-root.ts'),
  'utf8',
);

function decodeRecord(abi: Abi = TASK_COORDINATOR_ABI) {
  return decodeFunctionResult({ abi, functionName: 'getTask', data: PAYLOAD }) as Record<
    string,
    unknown
  >;
}

describe('TaskCoordinator.getTask decode (#4286)', () => {
  it('decodes the fixed payload at the right offsets', () => {
    expect(decodeRecord()).toEqual(RECORD);
  });

  it('encodes the record to the same fixed payload', () => {
    expect(encodeAbiParameters(getTaskOutputs, [RECORD])).toBe(PAYLOAD);
  });

  it('misreads the fixed payload through the old policy-as-uint8 literal', () => {
    // Known-bad control: the one-word `policy` shifts every later field one word early, which is
    // #4286's failure scenario. If this stops diverging, the payload no longer proves the offsets.
    const old = decodeRecord(OLD_GET_TASK_VIEW_ABI);
    expect(old.creatorCredited).toBe(true);
    expect(old.finalizedAttemptCount).toBe(3);
    expect(old.creatorCredited).not.toBe(RECORD.creatorCredited);
    expect(old.finalizedAttemptCount).not.toBe(RECORD.finalizedAttemptCount);
  });

  it('declares the record components the compiled contract returns', () => {
    // `policy` is a nested tuple occupying two head words, and `creator` then `taskCidDigest` are
    // components 0/1 because `getTaskCidDigest` (`adapters/mech/contracts.ts`) decodes
    // positionally at `task[1]`.
    expect(getTaskOutputs[0].components?.map((c) => `${c.name}:${c.type}`)).toEqual([
      'creator:address',
      'taskCidDigest:bytes32',
      'manifestDigest:bytes32',
      'status:uint8',
      'policy:tuple',
      'claimCount:uint32',
      'submittedCount:uint32',
      'finalizedAttemptCount:uint32',
      'creatorCredited:bool',
    ]);
    const policy = getTaskOutputs[0].components?.find((c) => c.name === 'policy');
    expect(policy?.components?.map((c) => `${c.name}:${c.type}`)).toEqual([
      'maxClaims:uint32',
      'allowSolverSelfEvaluation:bool',
    ]);
  });

  it('reads getTask through the shared slice, not a local literal', () => {
    expect(compositionRoot.includes('abi: TASK_COORDINATOR_ABI')).toBe(true);
    expect(compositionRoot).not.toMatch(/\bname\s*:\s*['"`]getTask['"`]/);
  });
});
