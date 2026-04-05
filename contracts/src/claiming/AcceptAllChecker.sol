// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IEligibilityChecker} from "./IEligibilityChecker.sol";

/// @title AcceptAllChecker - Phase 0 eligibility checker (always allows claims)
/// @author JIN Network
/// @notice Placeholder implementation — all providers are eligible to claim any request.
///         Replace with a reputation-gated or staking-gated checker when ready.
contract AcceptAllChecker is IEligibilityChecker {
    function canClaim(address, bytes32) external pure returns (bool) {
        return true;
    }
}
