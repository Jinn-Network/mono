// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title RegistryStub - Minimal placeholder for component/agent/service registries.
/// @notice Used during Phase 1a deployment where OLAS registries are not needed.
///         Tokenomics stores the address but only calls into registries during
///         epoch settlement for developer incentive tracking (unused in Phase 1a).
contract RegistryStub {
    // Tokenomics calls serviceRegistry.slashedFunds() via Treasury.drainServiceSlashedFunds()
    // Return zero so the call doesn't revert but also doesn't drain anything.
    function slashedFunds() external pure returns (uint256) {
        return 0;
    }

    // Tokenomics iterates service owners during trackServiceDonations.
    // Return empty arrays so the call completes without reverting.
    function getUnitIdsOfService(uint256) external pure returns (uint256[] memory, uint256[] memory) {
        return (new uint256[](0), new uint256[](0));
    }

    // Called by Tokenomics to check if a unit exists
    function exists(uint256) external pure returns (bool) {
        return false;
    }

    // Called by Tokenomics to get total supply of units
    function totalSupply() external pure returns (uint256) {
        return 0;
    }
}
