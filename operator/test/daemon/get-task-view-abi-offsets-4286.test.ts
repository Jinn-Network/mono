import { describe, expect, it } from 'vitest';
import { decodeFunctionResult, encodeFunctionResult, type Abi } from 'viem';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { GET_TASK_VIEW_ABI } from '../../src/daemon/composition-root.js';

/**
 * #4286: the operator's `getTask` ABI must match the compiled `TaskCoordinator.getTask`
 * output shape. `TaskRecord.policy` is a static nested tuple occupying two head words; the
 * previous hand-written literal declared it `uint8`, so every field after it decoded one word
 * early. The shift itself is silent — the encoded payload is merely longer than the declared
 * head, which viem does not object to.
 *
 * The encoder here is the compile output itself, so this test is a shape conformance check
 * against the source of truth rather than against another hand-copied literal.
 */
const require = createRequire(import.meta.url);
const COMPILED_ABI = JSON.parse(
  readFileSync(
    require.resolve('@jinn-network/contract-abis/generated/full/TaskCoordinator.json'),
    'utf8',
  ),
) as Abi;

const RECORD = {
  creator: '0x1111111111111111111111111111111111111111',
  taskCidDigest: `0x${'ab'.repeat(32)}`,
  manifestDigest: `0x${'cd'.repeat(32)}`,
  status: 2,
  policy: { maxClaims: 300, allowSolverSelfEvaluation: false },
  claimCount: 7,
  submittedCount: 5,
  finalizedAttemptCount: 3,
  creatorCredited: false,
} as const;

describe('GET_TASK_VIEW_ABI (#4286)', () => {
  const encoded = encodeFunctionResult({
    abi: COMPILED_ABI,
    functionName: 'getTask',
    result: RECORD as never,
  });

  it('decodes a real getTask return with every field at its true offset', () => {
    const task = decodeFunctionResult({
      abi: GET_TASK_VIEW_ABI,
      functionName: 'getTask',
      data: encoded,
    }) as typeof RECORD;

    // The field after `policy` — the sharpest offset probe. Under the shifted literal this
    // read `finalizedAttemptCount`'s word: `true` where that count is 1, and a hard
    // `InvalidBytesBooleanError` for any other non-zero count, as with the 3 used here.
    expect(task.creatorCredited).toBe(false);
    expect(task.claimCount).toBe(7);
    expect(task.submittedCount).toBe(5);
    expect(task.finalizedAttemptCount).toBe(3);
    // `maxClaims` above 255 survives: the shifted literal truncated it into a `uint8`.
    expect(task.policy).toEqual({ maxClaims: 300, allowSolverSelfEvaluation: false });
    // The call site's field, ahead of the shift, is unaffected either way.
    expect(task.taskCidDigest).toBe(RECORD.taskCidDigest);
  });
});
