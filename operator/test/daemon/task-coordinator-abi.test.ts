/**
 * `TaskCoordinator.getTask` decode offsets (#4286).
 *
 * `composition-root.ts` used to declare its own `GET_TASK_VIEW_ABI` with `policy` as a `uint8`.
 * The deployed contract returns it as a nested `(uint32 maxClaims, bool
 * allowSolverSelfEvaluation)` tuple, which occupies TWO head words -- so every field after
 * `policy` read one word early and `creatorCredited` was truthy for any non-zero
 * `finalizedAttemptCount`. All components are static, so viem decoded 9 of the 10 words without
 * throwing: silently wrong, no error. These tests decode a realistic record through the shared
 * `TASK_COORDINATOR_ABI` slice the call site now consumes and pin the fields after `policy`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeFunctionResult, encodeAbiParameters, getAbiItem } from 'viem';
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

/**
 * The fixture is encoded against the ABI under test's own `getTask` outputs, so it cannot drift
 * from the declaration it is meant to prove.
 */
const getTaskOutputs = getAbiItem({ abi: TASK_COORDINATOR_ABI, name: 'getTask' }).outputs;
const encoded = encodeAbiParameters(getTaskOutputs, [RECORD]);

const compositionRoot = readFileSync(
  resolve(fileURLToPath(new URL('.', import.meta.url)), '../../src/daemon/composition-root.ts'),
  'utf8',
);

function decodeRecord() {
  return decodeFunctionResult({
    abi: TASK_COORDINATOR_ABI,
    functionName: 'getTask',
    data: encoded,
  });
}

describe('TaskCoordinator.getTask decode (#4286)', () => {
  it('decodes the whole record at the right offsets', () => {
    // Decode this same (correctly encoded) payload through the deleted `GET_TASK_VIEW_ABI` and
    // four fields redden at once; `creatorCredited` is the sharpest, decoding `true` against a
    // fixture that says false. Swapping the `abi` here would not show that -- the fixture is
    // encoded from the same declaration, so the old literal fails at ENCODE instead. The proof
    // pins the old literal on the decode side only (recorded as P6 in the sweep's evidence).
    expect(decodeRecord()).toEqual(RECORD);
  });

  it('declares the record components the compiled contract returns', () => {
    // The pin the round trip above cannot supply: `policy` is a nested tuple occupying two head
    // words, and `creator` then `taskCidDigest` are components 0/1 because `getTaskCidDigest`
    // (`adapters/mech/contracts.ts`) decodes positionally at `task[1]`.
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
    expect(compositionRoot.includes("name: 'getTask'")).toBe(false);
  });
});
