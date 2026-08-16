import { describe, it, expect, vi } from 'vitest';
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData } from 'viem';
import {
  JINN_ROUTER_ABI,
  JINN_ROUTER_CLAIM_DELIVERY_V2_ABI,
} from '../../../src/adapters/mech/types.js';
import {
  ROUTER_TASK_CREATED_EVENT,
  ROUTER_SOLUTION_DELIVERY_CLAIMED_EVENT,
  ROUTER_DISCOVERY_EVENTS,
  MECH_DELIVER_EVENT,
  findLatestDeliveryForRequest,
  scanLatestDeliveryDataByRid,
} from '../../../src/adapters/mech/contracts.js';

describe('JinnRouter contract encoding', () => {
  const taskCidDigest = ('0x' + '11'.repeat(32)) as `0x${string}`;
  const manifestDigest = ('0x' + '22'.repeat(32)) as `0x${string}`;
  // Tokenless-OLAS pivot: on-chain policy is `maxClaims` + `allowSolverSelfEvaluation`.
  const policy = {
    maxClaims: 25,
    allowSolverSelfEvaluation: false,
  };

  it('encodes createTask calldata', () => {
    const calldata = encodeFunctionData({
      abi: JINN_ROUTER_ABI,
      functionName: 'createTask',
      args: [taskCidDigest, manifestDigest, policy, 1000000n, 1000000n, 300n],
    });
    expect(calldata).toMatch(/^0x/);

    const decoded = decodeFunctionData({
      abi: JINN_ROUTER_ABI,
      data: calldata,
    });
    expect(decoded.functionName).toBe('createTask');
    expect((decoded.args as unknown[])[0]).toBe(taskCidDigest);
    expect((decoded.args as unknown[])[1]).toBe(manifestDigest);
  });

  it('encodes claimTask calldata', () => {
    const priorityMech = '0x1234567890123456789012345678901234567890' as `0x${string}`;
    const calldata = encodeFunctionData({
      abi: JINN_ROUTER_ABI,
      functionName: 'claimTask',
      args: [1n, priorityMech],
    });

    const decoded = decodeFunctionData({
      abi: JINN_ROUTER_ABI,
      data: calldata,
    });
    expect(decoded.functionName).toBe('claimTask');
    expect((decoded.args as unknown[])[0]).toBe(1n);
    expect((decoded.args as unknown[])[1]).toBe(priorityMech);
  });

  it('encodes claimSolutionDelivery calldata', () => {
    const requestId = ('0x' + 'bb'.repeat(32)) as `0x${string}`;
    const evidenceHash = ('0x' + 'cc'.repeat(32)) as `0x${string}`;
    const calldata = encodeFunctionData({
      abi: JINN_ROUTER_ABI,
      functionName: 'claimSolutionDelivery',
      args: [requestId, evidenceHash],
    });

    const decoded = decodeFunctionData({
      abi: JINN_ROUTER_ABI,
      data: calldata,
    });
    expect(decoded.functionName).toBe('claimSolutionDelivery');
    expect((decoded.args as unknown[])[0]).toBe(requestId);
    expect((decoded.args as unknown[])[1]).toBe(evidenceHash);
  });

  it('encodes claimVerdictDelivery calldata', () => {
    const requestId = ('0x' + 'bb'.repeat(32)) as `0x${string}`;
    const evidenceHash = ('0x' + 'cc'.repeat(32)) as `0x${string}`;
    const calldata = encodeFunctionData({
      abi: JINN_ROUTER_ABI,
      functionName: 'claimVerdictDelivery',
      args: [requestId, evidenceHash, 1],
    });

    const decoded = decodeFunctionData({
      abi: JINN_ROUTER_ABI,
      data: calldata,
    });
    expect(decoded.functionName).toBe('claimVerdictDelivery');
    expect((decoded.args as unknown[])[0]).toBe(requestId);
    expect((decoded.args as unknown[])[1]).toBe(evidenceHash);
    expect((decoded.args as unknown[])[2]).toBe(1);
  });

  it('encodes V2 claimDelivery calldata with evidence hash', () => {
    const requestId = ('0x' + 'bb'.repeat(32)) as `0x${string}`;
    const evidenceHash = ('0x' + 'cc'.repeat(32)) as `0x${string}`;
    const calldata = encodeFunctionData({
      abi: JINN_ROUTER_CLAIM_DELIVERY_V2_ABI,
      functionName: 'claimDelivery',
      args: [requestId, evidenceHash],
    });

    const decoded = decodeFunctionData({
      abi: JINN_ROUTER_CLAIM_DELIVERY_V2_ABI,
      data: calldata,
    });
    expect(decoded.functionName).toBe('claimDelivery');
    expect((decoded.args as unknown[])[0]).toBe(requestId);
    expect((decoded.args as unknown[])[1]).toBe(evidenceHash);
  });

  it('decodes TaskCreated events', () => {
    const topics = encodeEventTopics({
      abi: JINN_ROUTER_ABI,
      eventName: 'TaskCreated',
      args: {
        creator: '0x1234567890123456789012345678901234567890',
        taskId: 1n,
        manifestDigest,
      },
    });
    const data = encodeAbiParameters(
      [
        { name: 'taskCidDigest', type: 'bytes32' },
        { name: 'maxClaims', type: 'uint32' },
        { name: 'solutionBudget', type: 'uint256' },
        { name: 'verdictBudget', type: 'uint256' },
      ],
      [taskCidDigest, policy.maxClaims, 25_000_000n, 25_000_000n],
    );

    const decoded = decodeEventLog({
      abi: JINN_ROUTER_ABI,
      eventName: 'TaskCreated',
      topics,
      data: data as `0x${string}`,
    });

    expect(decoded.eventName).toBe('TaskCreated');
    expect(decoded.args.taskId).toBe(1n);
    expect(decoded.args.taskCidDigest).toBe(taskCidDigest);
    expect(decoded.args.maxClaims).toBe(policy.maxClaims);
    expect(decoded.args.solutionBudget).toBe(25_000_000n);
    expect(decoded.args.verdictBudget).toBe(25_000_000n);
  });

  it('decodes TaskAttemptCreated events', () => {
    const requestId = ('0x' + '33'.repeat(32)) as `0x${string}`;
    const topics = encodeEventTopics({
      abi: JINN_ROUTER_ABI,
      eventName: 'TaskAttemptCreated',
      args: {
        taskId: 1n,
        attemptIndex: 0,
        requestId,
      },
    });
    const data = encodeAbiParameters(
      [
        { name: 'operator', type: 'address' },
        { name: 'priorityMech', type: 'address' },
        { name: 'deliveryRate', type: 'uint256' },
      ],
      [
        '0x1234567890123456789012345678901234567890',
        '0x3333333333333333333333333333333333333333',
        1_000_000n,
      ],
    );

    const decoded = decodeEventLog({
      abi: JINN_ROUTER_ABI,
      eventName: 'TaskAttemptCreated',
      topics,
      data,
    });

    expect(decoded.eventName).toBe('TaskAttemptCreated');
    expect(decoded.args.taskId).toBe(1n);
    expect(decoded.args.attemptIndex).toBe(0);
    expect(decoded.args.requestId).toBe(requestId);
  });
});

// #116: the Task-native polling path filters getLogs by topic0 using these ABI
// event items. Pin their names/shape so a future ABI rename can't silently empty
// a filter (getAbiItem throws on an absent name — these consts surface that loud).
describe('event-specific router log filters (#116)', () => {
  it('exposes the two router discovery events with the right names', () => {
    expect(ROUTER_TASK_CREATED_EVENT.type).toBe('event');
    expect(ROUTER_TASK_CREATED_EVENT.name).toBe('TaskCreated');
    expect(ROUTER_SOLUTION_DELIVERY_CLAIMED_EVENT.type).toBe('event');
    expect(ROUTER_SOLUTION_DELIVERY_CLAIMED_EVENT.name).toBe('SolutionDeliveryClaimed');
  });

  it('ROUTER_DISCOVERY_EVENTS is exactly [TaskCreated, SolutionDeliveryClaimed]', () => {
    expect(ROUTER_DISCOVERY_EVENTS).toHaveLength(2);
    expect(ROUTER_DISCOVERY_EVENTS.map((e) => e.name)).toEqual([
      'TaskCreated',
      'SolutionDeliveryClaimed',
    ]);
  });

  it('MECH_DELIVER_EVENT is the mech Deliver event', () => {
    expect(MECH_DELIVER_EVENT.type).toBe('event');
    expect(MECH_DELIVER_EVENT.name).toBe('Deliver');
  });

  it('scanLatestDeliveryDataByRid filters getLogs by the Deliver topic (not address-only)', async () => {
    const getLogs = vi.fn().mockResolvedValue([]);
    const mech = ('0x' + 'ab'.repeat(20)) as `0x${string}`;
    await scanLatestDeliveryDataByRid(
      { getLogs } as any,
      mech,
      0n,
      0n,
    );
    expect(getLogs).toHaveBeenCalledTimes(1);
    const arg = getLogs.mock.calls[0][0];
    expect(arg.address).toBe(mech);
    expect(arg.event).toBe(MECH_DELIVER_EVENT);
  });

  it('findLatestDeliveryForRequest returns the exact event transaction metadata', async () => {
    const mech = ('0x' + 'ab'.repeat(20)) as `0x${string}`;
    const serviceMultisig = ('0x' + 'cd'.repeat(20)) as `0x${string}`;
    const requestId = ('0x' + '11'.repeat(32)) as `0x${string}`;
    const deliveryDigest = ('0x' + '22'.repeat(32)) as `0x${string}`;
    const transactionHash = ('0x' + '33'.repeat(32)) as `0x${string}`;
    const topics = encodeEventTopics({
      abi: [MECH_DELIVER_EVENT],
      eventName: 'Deliver',
      args: {
        mech,
        mechServiceMultisig: serviceMultisig,
      },
    });
    const data = encodeAbiParameters(
      [
        { name: 'requestId', type: 'bytes32' },
        { name: 'deliveryRate', type: 'uint256' },
        { name: 'data', type: 'bytes' },
      ],
      [requestId, 1n, deliveryDigest],
    );
    const getLogs = vi.fn().mockResolvedValue([{
      address: mech,
      topics,
      data,
      transactionHash,
      blockNumber: 10n,
    }]);

    const recovered = await findLatestDeliveryForRequest(
      { getLogs } as any,
      mech,
      requestId,
      0n,
      10n,
    );
    expect(recovered).toMatchObject({
      requestId,
      deliveryDataHex: deliveryDigest,
      transactionHash,
      blockNumber: 10n,
    });
    expect(recovered?.mechAddress.toLowerCase()).toBe(
      serviceMultisig.toLowerCase(),
    );
  });
});
