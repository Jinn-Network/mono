// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

/// @title JinnInvariantTest — placeholder stub
/// @notice Foundry invariant harness for the JINN ERC20Votes token. The
///         actual invariants (totalSupply ≤ Σ mint events, voting power
///         monotonicity per voter checkpoint, minter-only mint, etc.)
///         will be authored under a follow-up to bd `jinn-mono-sz0`.
///
/// @dev    This stub exists so `forge test --match-contract Invariant`
///         exercises the toolchain end-to-end from day one. Adding
///         assertions here is the next concrete task.
contract JinnInvariantTest is Test {
    function setUp() public {}

    /// @notice Sentinel test that simply verifies the harness wires up.
    ///         Real invariants will replace this stub.
    function test_harnessWired() public pure {
        assertTrue(true);
    }
}
