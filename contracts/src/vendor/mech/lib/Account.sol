// SPDX-License-Identifier: GPL-3.0
// Vendored from valory-xyz/gnosis-mech — simplified to remove @account-abstraction/contracts dependency.
// OlasMech is operated by a Safe multisig (not ERC-4337 entry point), so the full
// BaseAccount implementation is not required for compilation or production use.
pragma solidity ^0.8.12;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";

/**
 * @dev Minimal account base that satisfies the interface expected by Mech without
 * pulling in the full ERC-4337 BaseAccount dependency chain.
 */
abstract contract Account is IERC1271 {
    // return value in case of signature validation success, with no time-range.
    uint256 private constant SIG_VALIDATION_SUCCEEDED = 0;

    // Hard-coded ERC-4337 entry point address (v0.6) for onlyOperator checks.
    address private constant _ENTRY_POINT = 0x0576a174D229E3cFA37253523E645A78A0C91B57;

    /// @dev Returns the ERC-4337 entry point.
    function entryPoint() public pure virtual returns (address) {
        return _ENTRY_POINT;
    }

    function isValidSignature(
        bytes32 hash,
        bytes memory signature
    ) public view virtual override returns (bytes4 magicValue);
}
