// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

/// @title JinnDistributorInvariantTest — placeholder stub
/// @notice Foundry invariant harness for the JinnDistributor. Real
///         invariants to author under follow-up:
///
///           1. monotonicity:
///                totalClaimedOperator[s] never decreases between
///                successive `claim()` calls.
///                totalClaimedDao[s]      never decreases between
///                successive `claim()` calls.
///
///           2. mint-equals-delta:
///                For each Claimed event, `operatorMinted` equals
///                `totalEntitledOperator − previous totalClaimedOperator`,
///                and analogously for the DAO side.
///
///           3. supply conservation:
///                token.totalSupply() == Σ {operatorMinted + daoMinted}
///                across all Claimed events.
///
///           4. resubmission idempotence:
///                Two consecutive `claim(proof)` calls with the same
///                weighted snapshot mint zero JINN on the second.
///
///           5. weight/ratio change is forward-only:
///                Lowering wTaskCreation, wSolutionDelivery, etc. never
///                burns supply nor decreases per-service accumulators.
///
///         These will be authored under a follow-up to bd
///         `jinn-mono-sz0`.
///
/// @dev    Stub harness; verifies forge-std wiring only.
contract JinnDistributorInvariantTest is Test {
    function setUp() public {}

    /// @notice Sentinel — replace with real invariants under follow-up.
    function test_harnessWired() public pure {
        assertTrue(true);
    }
}
