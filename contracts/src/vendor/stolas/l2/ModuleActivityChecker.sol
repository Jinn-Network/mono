// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StakingActivityChecker} from "../../registries/staking/StakingActivityChecker.sol";

// Multisig interface
interface IMultisig {
    /// @dev Returns array of owners.
    /// @return Array of Safe owners.
    function getOwners() external view returns (address[] memory);

    /// @dev Multisig activity tracker.
    function activityNonce() external view returns (uint256);
}

/// @dev Provided zero address.
error ZeroAddress();

/// @title ModuleActivityChecker - Smart contract for multisig module staking activity checking
contract ModuleActivityChecker is StakingActivityChecker {
    /// @dev ModuleActivityChecker constructor.
    /// @param _livenessRatio Liveness ratio in the format of 1e18.
    constructor(uint256 _livenessRatio) StakingActivityChecker(_livenessRatio) {}

    /// @dev Gets service multisig nonces.
    /// @param multisig Service multisig address.
    /// @return nonces Set of a nonce and a deliveries count for the multisig.
    function getMultisigNonces(address multisig) external view virtual override returns (uint256[] memory nonces) {
        nonces = new uint256[](1);
        address[] memory owners = IMultisig(multisig).getOwners();
        nonces[0] = IMultisig(owners[0]).activityNonce();
    }
}
