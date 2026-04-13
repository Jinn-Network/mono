// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Staking interface
interface IStaking {
    enum StakingState {
        Unstaked,
        Staked,
        Evicted
    }

    /// @dev Gets set of agent Ids.
    function getAgentIds() external view returns (uint256[] memory);

    /// @dev Gets service staking token.
    /// @return Service staking token address.
    function stakingToken() external view returns (address);

    /// @dev Gets minimum service staking deposit value required for staking.
    /// @return Minimum service staking deposit.
    function minStakingDeposit() external view returns (uint256);

    /// @dev Gets number of required agent instances in the service.
    /// @return Number of agent instances.
    function numAgentInstances() external view returns (uint256);

    /// @dev Gets the service threshold.
    /// @return Threshold.
    function threshold() external view returns (uint256);

    /// @dev Stakes the service.
    /// @param serviceId Service Id.
    function stake(uint256 serviceId) external;

    /// @dev Unstakes the service with collected reward, if available.
    /// @param serviceId Service Id.
    /// @return reward Staking reward.
    function unstake(uint256 serviceId) external returns (uint256);

    /// @dev Checkpoints and claims rewards for the service.
    /// @param serviceId Service Id.
    /// @return Staking reward.
    function claim(uint256 serviceId) external returns (uint256);

    /// @dev Checkpoints and claims rewards atomically.
    /// @param serviceId Service Id.
    /// @return Staking reward.
    function checkpointAndClaim(uint256 serviceId) external returns (uint256);

    /// @dev Verifies a service staking contract instance.
    /// @param instance Service staking proxy instance.
    /// @return True, if verification is successful.
    function verifyInstance(address instance) external view returns (bool);

    /// @dev Gets the service staking state.
    /// @param serviceId.
    /// @return stakingState Staking state of the service.
    function getStakingState(uint256 serviceId) external view returns (StakingState stakingState);

    /// @dev Gets available rewards.
    /// @return Available rewards amount.
    function availableRewards() external view returns (uint256);

    /// @dev Checkpoint to allocate rewards up until a current time.
    /// @return Staking service Ids (excluding evicted ones within a current epoch).
    /// @return Set of reward-eligible service Ids.
    /// @return Corresponding set of reward-eligible service rewards.
    /// @return Evicted service Ids.
    function checkpoint() external returns (uint256[] memory, uint256[] memory, uint256[] memory, uint256[] memory);
}
