/**
 * abi-invariance — manifestDigest rename was cosmetic at the wire level.
 *
 * Background: commit 217cb804 renamed `solverTypeDigest` to `manifestDigest`
 * across TaskCoordinator and JinnRouterV3. Function selectors and event
 * topic hashes are computed from parameter *types* (not names), so the
 * rename should not have changed any selector or topic. This test enforces
 * that invariant by hardcoding the pre-rename canonical signatures
 * (sourced from `git show 217cb804^:contracts/src/...`) and asserting the
 * post-rename ABI produces identical hashes.
 *
 * If a test in this file fails, the rename accidentally changed a TYPE
 * (or the signature changed for some other reason). Either revert the
 * type change or treat it as a breaking ABI change and update consumers
 * (subgraph schema, SDK encoders, off-chain indexers) in the same PR.
 *
 * Not gated; runs on every `yarn test`.
 */

import { expect } from 'chai';
import { Interface, id, keccak256, toUtf8Bytes } from 'ethers';
import { artifacts } from 'hardhat';

// Canonical pre-rename signatures from git@217cb804^:
//   contracts/src/tasks/TaskCoordinator.sol
//   contracts/src/staking/JinnRouterV3.sol
//
// Param names are deliberately omitted — the EVM does not see them, only
// types contribute to the selector / topic hash. The TaskPolicy tuple
// expands to (uint64,uint64,uint64,uint32,uint16,uint16,address,
//             (uint16,uint16,uint64,uint16,bool))
// where the trailing nested tuple is EvaluationPolicy.
const PRE_RENAME = {
  // TaskCoordinator.createTask(address creator, bytes32 taskCidDigest,
  //   bytes32 solverTypeDigest, TaskPolicy calldata policy)
  taskCoordinatorCreateTask:
    'createTask(address,bytes32,bytes32,(uint64,uint64,uint64,uint32,uint16,uint16,address,(uint16,uint16,uint64,uint16,bool)))',

  // JinnRouterV3.createTask(bytes32 taskCidDigest, bytes32 solverTypeDigest,
  //   TaskCoordinator.TaskPolicy calldata policy,
  //   uint256 solutionMaxDeliveryRate, uint256 verdictMaxDeliveryRate,
  //   uint256 responseTimeout)
  routerV3CreateTask:
    'createTask(bytes32,bytes32,(uint64,uint64,uint64,uint32,uint16,uint16,address,(uint16,uint16,uint64,uint16,bool)),uint256,uint256,uint256)',

  // TaskCoordinator.TaskCreated(uint256 indexed taskId, address indexed creator,
  //   bytes32 indexed solverTypeDigest, bytes32 taskCidDigest,
  //   uint16 maxClaims, uint16 requiredVerdicts,
  //   uint64 claimWindowStart, uint64 claimWindowEnd,
  //   uint64 submissionDeadline, uint64 evaluationDeadline)
  taskCoordinatorTaskCreated:
    'TaskCreated(uint256,address,bytes32,bytes32,uint16,uint16,uint64,uint64,uint64,uint64)',

  // JinnRouterV3.TaskCreated(address indexed creator, uint256 indexed taskId,
  //   bytes32 indexed solverTypeDigest, bytes32 taskCidDigest,
  //   uint16 maxClaims, uint16 requiredVerdicts,
  //   uint256 solutionBudget, uint256 verdictBudget)
  routerV3TaskCreated:
    'TaskCreated(address,uint256,bytes32,bytes32,uint16,uint16,uint256,uint256)',
};

function selectorOf(signature: string): string {
  return keccak256(toUtf8Bytes(signature)).slice(0, 10);
}

// ── Full-surface event invariance ─────────────────────────────────────────
//
// The `*CreateTask` selector and `*TaskCreated` topic0 above were sufficient
// when only the headline rename was at risk. The lists below extend the
// regression guard to every event emitted by both contracts so a future PR
// that retypes ANY param (whether or not it touches manifestDigest) fails
// loudly. Function selectors beyond `createTask` are not enumerated here:
// they have the same Solidity-language guarantee, and `createTask`'s pin
// already demonstrates the property — adding the rest would be belt-and-
// braces for marginal value.
//
// Signatures sourced from `git show 217cb804^:contracts/src/...`. Param
// names omitted (the EVM does not see them).
const TASK_COORDINATOR_EVENTS: Array<readonly [string, string]> = [
  ['Initialized',                  'Initialized(address,address)'],
  ['OwnershipTransferred',         'OwnershipTransferred(address,address)'],
  ['AuthorizedRouterUpdated',      'AuthorizedRouterUpdated(address,address)'],
  ['TaskCreated',                  PRE_RENAME.taskCoordinatorTaskCreated],
  ['TaskClaimed',                  'TaskClaimed(uint256,uint32,address,uint64)'],
  ['TaskAttemptRequestRegistered', 'TaskAttemptRequestRegistered(uint256,uint32,bytes32)'],
  ['TaskSubmitted',                'TaskSubmitted(uint256,uint32,address,bytes32,bytes32,uint256)'],
  ['EvaluationClaimed',            'EvaluationClaimed(uint256,uint32,uint32,address,uint64)'],
  ['VerdictRequestRegistered',     'VerdictRequestRegistered(uint256,uint32,uint32,bytes32)'],
  ['VerdictDelivered',             'VerdictDelivered(uint256,uint32,uint32,address,bytes32,uint8)'],
  ['AttemptFinalized',             'AttemptFinalized(uint256,uint32,bool,uint16,uint16)'],
  ['TaskCreationCreditLocked',     'TaskCreationCreditLocked(uint256,address,uint256)'],
  ['TaskAttemptExpired',           'TaskAttemptExpired(uint256,uint32,address)'],
];

const ROUTER_V3_EVENTS: Array<readonly [string, string]> = [
  ['Initialized',                  'Initialized(address,address,address,address)'],
  ['OwnershipTransferred',         'OwnershipTransferred(address,address)'],
  ['TaskCreated',                  PRE_RENAME.routerV3TaskCreated],
  ['TaskAttemptCreated',           'TaskAttemptCreated(uint256,uint32,bytes32,address,address,uint256)'],
  ['EvaluationAttemptCreated',     'EvaluationAttemptCreated(uint256,uint32,uint32,bytes32,address,address,uint256)'],
  ['SolutionDeliveryClaimed',      'SolutionDeliveryClaimed(address,bytes32,uint256,uint32)'],
  ['VerdictDeliveryClaimed',       'VerdictDeliveryClaimed(address,bytes32,uint256,uint32,uint32,uint8)'],
  ['TaskBudgetRefunded',           'TaskBudgetRefunded(uint256,address,uint256,uint256)'],
];

describe('abi-invariance — manifestDigest rename was cosmetic', function () {
  // Loading artifacts from the hardhat cache is cheap, but we keep a
  // generous timeout in case the suite runs cold.
  this.timeout(30_000);

  describe('TaskCoordinator', () => {
    let iface: Interface;
    before(async () => {
      const artifact = await artifacts.readArtifact('TaskCoordinator');
      iface = new Interface(artifact.abi);
    });

    it('createTask selector unchanged', () => {
      const expected = selectorOf(PRE_RENAME.taskCoordinatorCreateTask);
      const fn = iface.getFunction('createTask');
      if (!fn) throw new Error('createTask not found in post-rename TaskCoordinator ABI');
      expect(fn.selector).to.equal(
        expected,
        `selector drift: post-rename TaskCoordinator.createTask = ${fn.selector}, ` +
          `pre-rename signature ${PRE_RENAME.taskCoordinatorCreateTask} = ${expected}. ` +
          `The manifestDigest rename should be cosmetic — a selector change means a TYPE changed.`,
      );
    });

    for (const [eventName, preRenameSig] of TASK_COORDINATOR_EVENTS) {
      it(`${eventName} topic0 unchanged`, () => {
        const expected = id(preRenameSig);
        const ev = iface.getEvent(eventName);
        if (!ev) throw new Error(`${eventName} not found in post-rename TaskCoordinator ABI`);
        expect(ev.topicHash).to.equal(
          expected,
          `topic0 drift: post-rename TaskCoordinator.${eventName} = ${ev.topicHash}, ` +
            `pre-rename signature ${preRenameSig} = ${expected}. ` +
            `Subgraph eventHandlers key off topic0 — drift unwires the indexer.`,
        );
      });
    }
  });

  describe('JinnRouterV3', () => {
    let iface: Interface;
    before(async () => {
      const artifact = await artifacts.readArtifact('JinnRouterV3');
      iface = new Interface(artifact.abi);
    });

    it('createTask selector unchanged', () => {
      const expected = selectorOf(PRE_RENAME.routerV3CreateTask);
      const fn = iface.getFunction('createTask');
      if (!fn) throw new Error('createTask not found in post-rename JinnRouterV3 ABI');
      expect(fn.selector).to.equal(
        expected,
        `selector drift: post-rename JinnRouterV3.createTask = ${fn.selector}, ` +
          `pre-rename signature ${PRE_RENAME.routerV3CreateTask} = ${expected}. ` +
          `Subgraph mappings + SDK encoders depend on selector stability.`,
      );
    });

    for (const [eventName, preRenameSig] of ROUTER_V3_EVENTS) {
      it(`${eventName} topic0 unchanged`, () => {
        const expected = id(preRenameSig);
        const ev = iface.getEvent(eventName);
        if (!ev) throw new Error(`${eventName} not found in post-rename JinnRouterV3 ABI`);
        expect(ev.topicHash).to.equal(
          expected,
          `topic0 drift: post-rename JinnRouterV3.${eventName} = ${ev.topicHash}, ` +
            `pre-rename signature ${preRenameSig} = ${expected}. ` +
            `Subgraph eventHandlers key off topic0 — drift unwires the indexer.`,
        );
      });
    }
  });
});
