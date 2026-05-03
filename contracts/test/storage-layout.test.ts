/**
 * Storage-layout drift CI guard.
 *
 * Pins the slot of state variables whose position is load-bearing across
 * contract boundaries (storage proofs, proxy upgrades). A test failure here
 * means a downstream consumer would silently break — fix the source before
 * merging.
 *
 * Mechanism: shells out to `forge inspect <Path>:<Contract> storage-layout`
 * (Foundry is already required for the invariant suite under
 * test/jinn/invariants/). One `it()` per pinned variable for clear failures.
 *
 * To intentionally change a pinned slot:
 *   1. Confirm the downstream consumer named in the failure is updated
 *      (constants in CanonicalOpStackMessenger.sol, proxy storage layout
 *      docs, deployment metadata, etc.).
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
 *   - JINN ERC20 inherited OZ slots — managed by OZ and not read off-chain
 *     via storage proof.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
const { expect } = require('chai');

interface PinnedSlot {
  contractPath: string; // forge inspect identifier `<src-path>:<ContractName>`
  variable: string;
  expectedSlot: string; // forge returns slot as a decimal string
  /** What breaks if this slot drifts. Surfaced in the failure message. */
  downstream: string;
}

const PINNED_SLOTS: PinnedSlot[] = [
  {
    contractPath: 'src/jinn/cross-chain/TaskClaimEmitter.sol:TaskClaimEmitter',
    variable: 'nextClaimId',
    expectedSlot: '0',
    downstream:
      'CanonicalOpStackMessenger.CLAIM_SNAPSHOT_HASHES_SLOT (slot 1) assumes TaskClaimEmitter.nextClaimId occupies slot 0 immediately preceding the claimSnapshotHashes mapping.',
  },
  {
    contractPath: 'src/jinn/cross-chain/TaskClaimEmitter.sol:TaskClaimEmitter',
    variable: 'claimSnapshotHashes',
    expectedSlot: '1',
    downstream:
      'CanonicalOpStackMessenger.sol hardcodes CLAIM_SNAPSHOT_HASHES_SLOT = 1 and derives the proof slot as keccak256(abi.encode(claimId, 1)). A drift here silently breaks every canonical Task-native L2→L1 claim proof.',
  },
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
];

/**
 * Run `forge inspect` and parse the storage-layout JSON. forge writes parser
 * warnings to stderr; we capture stdout only.
 */
function readStorageLayout(contractPath: string): Array<{ label: string; slot: string }> {
  const cwd = path.resolve(__dirname, '..');
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
