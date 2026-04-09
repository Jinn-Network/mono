// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/**
 * @title MockSafeWithNonce
 * @notice Minimal mock of a Gnosis Safe for testing getMultisigNonces.
 *         Exposes a `nonce()` view function as required by JinnRouter's IMultisig interface.
 *         Not a production contract — test-only.
 */
contract MockSafeWithNonce {
    uint256 public nonce;

    /// @dev Increments the nonce (simulates a Safe transaction).
    function incrementNonce() external {
        nonce++;
    }
}
