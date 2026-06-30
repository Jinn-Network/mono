/**
 * Storage-layout drift CI guard.
 *
 * Pins the slot of state variables whose position is load-bearing across
 * contract boundaries (storage proofs, proxy upgrades). A test failure here
 * means a downstream consumer would silently break — fix the source before
 * merging.
 *
 * Mechanism: shells out to `forge inspect <Path>:<Contract> storage-layout`
 * (Foundry is required for this guard). One `it()` per pinned variable for
 * clear failures.
 *
 * To intentionally change a pinned slot:
 *   1. Confirm the downstream consumer named in the failure is updated
 *      (proxy storage layout docs, deployment metadata, etc.).
 *   2. Edit the expected slot in PINNED_SLOTS below in the same PR.
 *   3. Note the rationale in the commit message; the test diff is the audit
 *      trail.
 *
 * Other contract-internal slot assumptions noticed but NOT pinned (no
 * cross-contract reader, so layout is free to change with the contract):
 *   - RestorationActivityCheckerV2.evidenceHashes (slot 5),
 *     _evidenceWriteIndex (slot 6) — circular buffer; only `this` reads it.
 *   - Historical JinnRouterV2 activity counters (creationCount …
 *     evaluationDeliveryCount, slots 5–8) — only the contract itself and
 *     legacy ABI callers read these.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { expect } from 'chai';

interface PinnedSlot {
  contractPath: string; // forge inspect identifier `<src-path>:<ContractName>`
  variable: string;
  expectedSlot: string; // forge returns slot as a decimal string
  /** What breaks if this slot drifts. Surfaced in the failure message. */
  downstream: string;
}

const PINNED_SLOTS: PinnedSlot[] = [
  {
    contractPath: 'src/staking/JinnRouterV2.sol:JinnRouterV2',
    variable: 'creators',
    // NOTE: inline source comments in JinnRouterV2.sol describe `creators` as
    // "slot 13", but Solidity packs `bool initialized` and `address activityChecker`
    // into a single slot (slot 4), so the actual compiled slot is 12. The
    // contract-internal layout is what matters for proxy upgrade safety; we pin
    // to the observed value. (Source comments could be corrected in a follow-up.)
    expectedSlot: '12',
    downstream:
      'JinnRouterV2 is deployed behind an upgradeable proxy. Proxy upgrades skip the constructor, so there is NO assembly guard — only this CI check enforces layout stability for the V2 → V2.1 upgrade path used by the `pwg` ops phase.',
  },
  {
    contractPath: 'src/tasks/TaskCoordinator.sol:TaskCoordinator',
    variable: 'nextTaskId',
    // NOTE: declaration order suggested slot 3, but Solidity packs the
    // address `authorizedRouter` and `bool initialized` into slot 1, shifting
    // nextTaskId up to slot 2.
    expectedSlot: '2',
    downstream:
      'TaskCoordinator is deployed behind JinnUpgradeableProxy. Drift on nextTaskId silently corrupts task ID assignment across upgrades — pre-cutover tasks become unreachable. The 217cb804 manifestDigest rename was cosmetic; this pin is the regression guard for any future PR that reorders state.',
  },
  {
    contractPath: 'src/tasks/TaskCoordinator.sol:TaskCoordinator',
    variable: '_tasks',
    // NOTE: declaration order suggested slot 4; actual is slot 3 because of
    // the authorizedRouter/initialized packing in slot 1 (see nextTaskId pin).
    expectedSlot: '3',
    downstream:
      'TaskCoordinator._tasks holds every persisted TaskRecord (creator, taskCidDigest, manifestDigest, status, policy, claimCount). Drift makes ALL pre-upgrade tasks unreadable via getTask/claimTask.',
  },
  {
    contractPath: 'src/staking/JinnRouterV3.sol:JinnRouterV3',
    variable: 'taskCoordinator',
    expectedSlot: '3',
    downstream:
      'JinnRouterV3.taskCoordinator address is read from storage on every createTask/claimTask. Drift unwires the router from the coordinator proxy.',
  },
  {
    contractPath: 'src/staking/JinnRouterV3.sol:JinnRouterV3',
    variable: 'taskPayments',
    // NOTE: declaration order suggested slot 9, but slot 3 packs
    // `taskCoordinator` (address) + `initialized` (bool), shifting all
    // subsequent mapping slots down by one. Actual slot is 8.
    expectedSlot: '8',
    downstream:
      'JinnRouterV3.taskPayments holds creator, manifestDigest, and JINN budget remaining for every task. Drift makes pre-upgrade tasks unrefundable and unverifiable.',
  },
  // ── Phase-7 cutover regression-guard expansion ────────────────────────────
  // The pins above were sufficient to catch silent slot drift on the headline
  // mappings touched by the manifestDigest rename. The pins below extend the
  // guard to the rest of the load-bearing state on both contracts so future
  // refactors that reorder fields fail loudly before the proxy upgrade runs.
  {
    contractPath: 'src/staking/JinnRouterV3.sol:JinnRouterV3',
    variable: 'mechMarketplace',
    expectedSlot: '1',
    downstream:
      'JinnRouterV3.mechMarketplace is the OLAS mech marketplace address read on every createTask. Drift unwires the router from the marketplace.',
  },
  {
    contractPath: 'src/staking/JinnRouterV3.sol:JinnRouterV3',
    variable: 'activityChecker',
    expectedSlot: '2',
    downstream:
      'JinnRouterV3.activityChecker provides the canClaim policy hook. Drift breaks operator claim eligibility checks.',
  },
  {
    contractPath: 'src/staking/JinnRouterV3.sol:JinnRouterV3',
    variable: 'requestKinds',
    expectedSlot: '4',
    downstream:
      'JinnRouterV3.requestKinds maps requestId → RequestKind. Drift makes pre-upgrade open requests unrecognized; in-flight tasks orphan.',
  },
  {
    contractPath: 'src/staking/JinnRouterV3.sol:JinnRouterV3',
    variable: 'claimed',
    expectedSlot: '5',
    downstream:
      'JinnRouterV3.claimed is the dedup set for processed setMetadata events. Drift causes double-spend on JINN budget refunds.',
  },
  {
    contractPath: 'src/staking/JinnRouterV3.sol:JinnRouterV3',
    variable: 'solutionDeliveryClaimed',
    expectedSlot: '6',
    downstream:
      'Solution-delivery dedup set. Drift permits double-payment to solvers.',
  },
  {
    contractPath: 'src/staking/JinnRouterV3.sol:JinnRouterV3',
    variable: 'verdictDeliveryClaimed',
    expectedSlot: '7',
    downstream:
      'Verdict-delivery dedup set. Drift permits double-payment to evaluators.',
  },
  {
    contractPath: 'src/tasks/TaskCoordinator.sol:TaskCoordinator',
    variable: '_attempts',
    expectedSlot: '4',
    downstream:
      'TaskCoordinator._attempts holds AttemptRecord per (taskId, attemptIndex). Drift makes pre-upgrade in-flight attempts unreachable; solvers cannot submit.',
  },
  {
    contractPath: 'src/tasks/TaskCoordinator.sol:TaskCoordinator',
    variable: '_verdicts',
    expectedSlot: '5',
    downstream:
      'TaskCoordinator._verdicts holds VerdictRecord per (taskId, attemptIndex, verdictIndex). Drift makes pre-upgrade verdicts unreachable; evaluators cannot finalize.',
  },
  {
    contractPath: 'src/tasks/TaskCoordinator.sol:TaskCoordinator',
    variable: '_requestRefs',
    // NOTE: the tokenless-OLAS trim removed the `claimsByTaskByOperator` (was slot 6) and
    // `verdictClaimsByAttemptByEvaluator` (was slot 7) per-operator/per-evaluator cap mappings,
    // shifting _requestRefs down from slot 8 to slot 6.
    expectedSlot: '6',
    downstream:
      'TaskCoordinator._requestRefs maps mech requestId → (taskId, attemptIndex). Drift orphans pre-upgrade pending requests.',
  },
  {
    contractPath: 'src/tasks/TaskCoordinator.sol:TaskCoordinator',
    variable: '_verdictRequestRefs',
    // NOTE: shifted from slot 9 to slot 7 by the same tokenless-OLAS cap-mapping removal that
    // moved _requestRefs (see above).
    expectedSlot: '7',
    downstream:
      'TaskCoordinator._verdictRequestRefs maps verdict request → (taskId, attemptIndex, verdictIndex). Drift orphans pre-upgrade evaluator requests.',
  },
  {
    contractPath: 'src/staking/TaskActivityCheckerV3.sol:TaskActivityCheckerV3',
    variable: 'eligibleActivityWeight',
    expectedSlot: '16',
    downstream:
      'StakingBase reads TaskActivityCheckerV3.eligibleActivityWeight as the activity weight at checkpoint (via getMultisigNonces/isRatioPass). The tokenless-OLAS in-place checker upgrade reuses the live proxy storage, so this slot must not move — drift would zero out every staker\'s liveness signal across the upgrade.',
  },
];

/**
 * Run `forge inspect` and parse the storage-layout JSON. forge writes parser
 * warnings to stderr; we capture stdout only.
 */
function readStorageLayout(contractPath: string): Array<{ label: string; slot: string }> {
  const cwd = path.resolve(import.meta.dirname, '..');
  const stdout = execFileSync(
    'forge',
    ['inspect', contractPath, 'storage-layout', '--json'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const parsed = JSON.parse(stdout) as { storage?: Array<{ label: string; slot: string }> };
  if (!parsed.storage) {
    throw new Error(`forge inspect returned no storage layout for ${contractPath}`);
  }
  return parsed.storage;
}

describe('storage-layout drift guard', function () {
  // forge cold-start can take a few seconds in CI.
  this.timeout(120_000);

  for (const pin of PINNED_SLOTS) {
    it(`pins ${pin.contractPath.split(':')[1]}.${pin.variable} at slot ${pin.expectedSlot}`, function () {
      const layout = readStorageLayout(pin.contractPath);
      const entry = layout.find((s) => s.label === pin.variable);
      if (!entry) {
        throw new Error(
          `Variable ${pin.variable} not found in ${pin.contractPath}. ` +
            `Either it was renamed (update the pin) or removed (verify ${pin.downstream}).`,
        );
      }
      expect(entry.slot, buildDriftMessage(pin, entry.slot)).to.equal(pin.expectedSlot);
    });
  }
});

function buildDriftMessage(pin: PinnedSlot, observedSlot: string): string {
  return [
    '',
    `Storage slot drift on ${pin.contractPath}.${pin.variable}`,
    `  expected slot: ${pin.expectedSlot}`,
    `  observed slot: ${observedSlot}`,
    `  downstream impact: ${pin.downstream}`,
    `  if this drift is intentional, update PINNED_SLOTS in test/storage-layout.test.ts`,
    `  in the same PR that updates the downstream consumer.`,
    '',
  ].join('\n');
}
