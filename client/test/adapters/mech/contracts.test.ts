import { describe, it, expect } from 'vitest';
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
} from '../../../src/adapters/mech/contracts.js';

describe('JinnRouter contract encoding', () => {
  const taskCidDigest = ('0x' + '11'.repeat(32)) as `0x${string}`;
  const manifestDigest = ('0x' + '22'.repeat(32)) as `0x${string}`;
  const policy = {
    claimWindowStart: 1n,
    claimWindowEnd: 2n,
    submissionDeadline: 3n,
    claimLeaseTtlSeconds: 300,
    maxClaims: 25,
    maxClaimsPerOperator: 1,
    policyHook: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    evaluationPolicy: {
      requiredVerdicts: 1,
      passThreshold: 1,
      evaluationDeadline: 4n,
      maxVerdictsPerEvaluator: 1,
      disallowSolverSelfEvaluation: true,
    },
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
        { name: 'maxClaims', type: 'uint16' },
        { name: 'requiredVerdicts', type: 'uint16' },
        { name: 'solutionBudget', type: 'uint256' },
        { name: 'verdictBudget', type: 'uint256' },
      ],
      [taskCidDigest, policy.maxClaims, policy.evaluationPolicy.requiredVerdicts, 25_000_000n, 25_000_000n],
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
    expect(decoded.args.requiredVerdicts).toBe(policy.evaluationPolicy.requiredVerdicts);
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
});
