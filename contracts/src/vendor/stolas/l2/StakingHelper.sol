// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IStakingFactory {
    /// @dev Gets InstanceParams struct for a specified staking proxy
    /// @param stakingProxy Staking proxy address.
    /// @return implementation Staking implementation address.
    /// @return isEnabled Staking proxy status flag.
    function mapInstanceParams(address stakingProxy)
        external
        view
        returns (address implementation, address, bool isEnabled);
}

interface IStakingProxy {
    /// @dev Gets maximum number of staking services.
    function maxNumServices() external view returns (uint256);
    /// @dev Gets minimum deposit value required for service staking.
    function minStakingDeposit() external view returns (uint256);
    /// @dev Gets token rewards.
    function availableRewards() external view returns (uint256);
}

/// @dev Zero address.
error ZeroAddress();

/// @title StakingHelper - Smart contract for helper functions about staking contracts.
contract StakingHelper {
    // Staking factory address
    address public immutable stakingFactory;

    /// @dev StakingHelper constructor.
    /// @param _stakingFactory Staking factory address.
    constructor(address _stakingFactory) {
        // Check for zero address
        if (_stakingFactory == address(0)) {
            revert ZeroAddress();
        }

        stakingFactory = _stakingFactory;
    }

    /// @dev Gets stakingProxy info.
    /// @param stakingProxy Staking proxy address.
    /// @return bytecodeHash Staking implementation bytecode hash.
    /// @return isEnabled Staking proxy status flag.
    /// @return maxNumSlots Max number of slots in staking proxy.
    /// @return minStakingDeposit Minimum deposit value required for service staking.
    /// @return availableRewards Staking proxy available rewards.
    function getStakingInfo(address stakingProxy)
        external
        view
        returns (
            bytes32 bytecodeHash,
            bool isEnabled,
            uint256 maxNumSlots,
            uint256 minStakingDeposit,
            uint256 availableRewards
        )
    {
        // Get stakingProxy status
        address implementation;
        (implementation,, isEnabled) = IStakingFactory(stakingFactory).mapInstanceParams(stakingProxy);

        // Get bytecode hash
        bytecodeHash = implementation.codehash;

        // Get max number of services in stakingProxy
        maxNumSlots = IStakingProxy(stakingProxy).maxNumServices();

        // Get min staking deposit in stakingProxy
        minStakingDeposit = IStakingProxy(stakingProxy).minStakingDeposit();

        // Get stakingProxy available rewards
        availableRewards = IStakingProxy(stakingProxy).availableRewards();
    }
}
