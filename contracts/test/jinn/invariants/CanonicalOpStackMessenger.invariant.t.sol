// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

/// @title CanonicalOpStackMessengerInvariantTest — placeholder stub
/// @notice Foundry invariant harness for the canonical OP-Stack
///         messenger. The canonical path now verifies L2 account/storage
///         proofs for claimSnapshotHashes[claimId]; the remaining follow-up
///         is invariant authoring:
///
///           1. statelessness:
///                `verifyClaim` writes no storage. Property: between
///                two calls of `verifyClaim`, every storage slot of the
///                contract is unchanged (approximate via vm.load + a
///                hashed sample of slots; full coverage via `vm.snapshot`
///                + `vm.revertTo`).
///
///           2. proof envelope binding:
///                Proofs that decode but mismatch the expected emitter
///                account proof, storage slot, or stored snapshot hash
///                always revert.
///
///           3. tuple recovery surjective:
///                Given a well-formed storage proof, the returned tuple
///                equals the values committed by the proven snapshot hash.
///
///           4. dispute-game finality:
///                `verifyClaim` reverts whenever
///                game.status() != DEFENDER_WINS or the airgap timer
///                has not elapsed. Tests must stub
///                IDisputeGameFactory + generic IDisputeGame to drive
///                these states.
///
///           5. storage MPT inclusion:
///                Mutating any byte of the account/storage proof
///                without rebuilding the root produces a revert.
///
///         These will be authored under a follow-up to bd
///         `jinn-mono-sz0`.
///
/// @dev    Stub harness; verifies forge-std wiring only.
contract CanonicalOpStackMessengerInvariantTest is Test {
    function setUp() public {}

    /// @notice Sentinel — replace with real invariants under follow-up.
    function test_harnessWired() public pure {
        assertTrue(true);
    }
}
