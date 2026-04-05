// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title IEligibilityChecker - Generic eligibility interface for claim gating
/// @author JIN Network
/// @notice ClaimRegistry delegates eligibility decisions to implementations of this interface.
///         Follows the same pattern as OLAS activity checkers — swappable by owner.
interface IEligibilityChecker {
    /// @notice Check if a provider is eligible to claim a specific request
    /// @param provider Address attempting to claim (operator's Safe)
    /// @param requestId The marketplace request ID being claimed
    /// @return True if the provider is eligible to claim
    function canClaim(address provider, bytes32 requestId) external view returns (bool);
}
