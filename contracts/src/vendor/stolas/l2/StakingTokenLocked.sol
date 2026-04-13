// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC721TokenReceiver} from "../../registries/ERC721TokenReceiver.sol";
import {SafeTransferLib} from "../../registries/SafeTransferLib.sol";

// Staking Activity Checker interface
interface IActivityChecker {
    /// @dev Gets service multisig nonces.
    /// @param multisig Service multisig address.
    /// @return nonces Set of a single service multisig nonce.
    function getMultisigNonces(address multisig) external view returns (uint256[] memory nonces);

    /// @dev Checks if the service multisig liveness ratio passes the defined liveness threshold.
    /// @notice The formula for calculating the ratio is the following:
    ///         currentNonce - service multisig nonce at time now (block.timestamp);
    ///         lastNonce - service multisig nonce at the previous checkpoint or staking time (tsStart);
    ///         ratio = (currentNonce - lastNonce) / (block.timestamp - tsStart).
    /// @param curNonces Current service multisig set of a single nonce.
    /// @param lastNonces Last service multisig set of a single nonce.
    /// @param ts Time difference between current and last timestamps.
    /// @return ratioPass True, if the liveness ratio passes the check.
    function isRatioPass(uint256[] memory curNonces, uint256[] memory lastNonces, uint256 ts)
        external
        view
        returns (bool ratioPass);
}

// Service Registry interface
interface IService {
    enum ServiceState {
        NonExistent,
        PreRegistration,
        ActiveRegistration,
        FinishedRegistration,
        Deployed,
        TerminatedBonded
    }

    // Service agent params struct
    struct AgentParams {
        // Number of agent instances
        uint32 slots;
        // Bond per agent instance
        uint96 bond;
    }

    // Service parameters
    struct Service {
        // Registration activation deposit
        uint96 securityDeposit;
        // Multisig address for agent instances
        address multisig;
        // IPFS hashes pointing to the config metadata
        bytes32 configHash;
        // Agent instance signers threshold
        uint32 threshold;
        // Total number of agent instances
        uint32 maxNumAgentInstances;
        // Actual number of agent instances
        uint32 numAgentInstances;
        // Service state
        ServiceState state;
        // Canonical agent Ids for the service
        uint32[] agentIds;
    }

    /// @dev Transfers the service that was previously approved to this contract address.
    /// @param from Account address to transfer from.
    /// @param to Account address to transfer to.
    /// @param id Service Id.
    function safeTransferFrom(address from, address to, uint256 id) external;

    /// @dev Transfers the service that was previously approved to this contract address.
    /// @param from Account address to transfer from.
    /// @param to Account address to transfer to.
    /// @param id Service Id.
    function transferFrom(address from, address to, uint256 id) external;

    /// @dev Gets the service instance.
    /// @param serviceId Service Id.
    /// @return service Corresponding Service struct.
    function getService(uint256 serviceId) external view returns (Service memory service);

    /// @dev Gets service agent parameters: number of agent instances (slots) and a bond amount.
    /// @param serviceId Service Id.
    /// @return numAgentIds Number of canonical agent Ids in the service.
    /// @return agentParams Set of agent parameters for each canonical agent Id.
    function getAgentParams(uint256 serviceId)
        external
        view
        returns (uint256 numAgentIds, AgentParams[] memory agentParams);

    /// @dev Gets the service security token info.
    /// @param serviceId Service Id.
    /// @return Token address.
    /// @return Token security deposit.
    function mapServiceIdTokenDeposit(uint256 serviceId) external view returns (address, uint96);
}

/// @dev Only `owner` has a privilege, but the `sender` was provided.
/// @param sender Sender address.
/// @param owner Required sender address as an owner.
error OwnerOnly(address sender, address owner);

/// @dev Provided zero address.
error ZeroAddress();

/// @dev Provided zero value.
error ZeroValue();

/// @dev The deployed activity checker must be a contract.
/// @param activityChecker Activity checker address.
error ContractOnly(address activityChecker);

/// @dev Agent Id is not correctly provided for the current routine.
/// @param agentId Component Id.
error WrongAgentId(uint256 agentId);

/// @dev Wrong state of a service.
/// @param state Service state.
/// @param serviceId Service Id.
error WrongServiceState(uint256 state, uint256 serviceId);

/// @dev The contract is already initialized.
error AlreadyInitialized();

/// @dev Maximum number of staking services is reached.
/// @param maxNumServices Maximum number of staking services.
error MaxNumServicesReached(uint256 maxNumServices);

/// @dev Received lower value than the expected one.
/// @param provided Provided value is lower.
/// @param expected Expected value.
error LowerThan(uint256 provided, uint256 expected);

/// @dev Service is not unstaked.
/// @param serviceId Service Id.
error ServiceNotUnstaked(uint256 serviceId);

/// @dev Service is not found.
/// @param serviceId Service Id.
error ServiceNotFound(uint256 serviceId);

/// @dev The staking token is wrong.
/// @param expected Expected staking token.
/// @param provided Provided staking token.
error WrongStakingToken(address expected, address provided);

/// @dev Account is unauthorized.
/// @param account Account address.
error UnauthorizedAccount(address account);

// Service Info struct
struct ServiceInfo {
    // Service multisig address
    address multisig;
    // Service owner
    address owner;
    // Service multisig nonces
    uint256[] nonces;
    // Staking start time
    uint256 tsStart;
    // Accumulated service staking reward
    uint256 reward;
}

/// @title StakingTokenLocked - Smart contract for staking a service with a token stake via a specific stakingManager
contract StakingTokenLocked is ERC721TokenReceiver {
    enum StakingState {
        Unstaked,
        Staked
    }

    // Input staking parameters
    struct StakingParams {
        // Subset of default OLAS staking contract variables
        // Metadata staking information
        bytes32 metadataHash;
        // Maximum number of staking services
        uint256 maxNumServices;
        // Rewards per second
        uint256 rewardsPerSecond;
        // Minimum service staking deposit value required for staking
        uint256 minStakingDeposit;
        // Liveness period
        uint256 livenessPeriod;
        // Time for emissions
        uint256 timeForEmissions;
        // Optional agent Ids requirement
        uint256[] agentIds;
        // ServiceRegistry contract address
        address serviceRegistry;
        // Service activity checker address
        address activityChecker;

        // LST extended variables
        // ServiceRegistryTokenUtility address
        address serviceRegistryTokenUtility;
        // Security token address for staking corresponding to service deposit token
        address stakingToken;
        // Staking manager address
        address stakingManager;
    }

    event ServiceStaked(
        uint256 epoch, uint256 indexed serviceId, address indexed owner, address indexed multisig, uint256[] nonces
    );
    event Checkpoint(
        uint256 indexed epoch, uint256 availableRewards, uint256[] serviceIds, uint256[] rewards, uint256 epochLength
    );
    event ServiceUnstaked(
        uint256 epoch,
        uint256 indexed serviceId,
        address indexed owner,
        address indexed multisig,
        uint256[] nonces,
        uint256 reward,
        uint256 availableRewards
    );
    event RewardClaimed(
        uint256 epoch,
        uint256 indexed serviceId,
        address indexed owner,
        address indexed multisig,
        uint256[] nonces,
        uint256 reward
    );
    event Deposit(address indexed sender, uint256 amount, uint256 balance, uint256 availableRewards);
    event Withdraw(address indexed to, uint256 amount);

    // Default OLAS staking variables
    // Contract version
    string public constant VERSION = "0.1.0";
    // Staking parameters for initialization
    // Metadata staking information
    bytes32 public metadataHash;
    // Maximum number of staking services
    uint256 public maxNumServices;
    // Rewards per second
    uint256 public rewardsPerSecond;
    // Minimum service staking deposit value required for staking
    // The staking deposit must be always greater than 1 in order to distinguish between native and ERC20 tokens
    uint256 public minStakingDeposit;
    // Max number of accumulated inactivity periods after which the service is evicted
    uint256 public maxNumInactivityPeriods;
    // Liveness period
    uint256 public livenessPeriod;
    // Time for emissions
    uint256 public timeForEmissions;
    // Number of agent instances in the service
    uint256 public numAgentInstances;
    // Optional service multisig threshold requirement
    uint256 public threshold;
    // Optional service configuration hash requirement
    bytes32 public configHash;
    // Approved multisig proxy hash
    bytes32 public proxyHash;
    // ServiceRegistry contract address
    address public serviceRegistry;
    // Service activity checker address
    address public activityChecker;

    // LST specific variables
    // ServiceRegistryTokenUtility address
    address public serviceRegistryTokenUtility;
    // Security token address for staking corresponding to the service deposit token
    address public stakingToken;
    // Staking manager address
    address public stakingManager;

    // The rest of state variables
    // Min staking duration
    uint256 public minStakingDuration;
    // Max allowed inactivity period
    uint256 public maxInactivityDuration;
    // Epoch counter
    uint256 public epochCounter;
    // Token / ETH balance
    uint256 public balance;
    // Token / ETH available rewards
    uint256 public availableRewards;
    // Calculated emissions amount
    uint256 public emissionsAmount;
    // Timestamp of the last checkpoint
    uint256 public tsCheckpoint;
    // Optional agent Ids requirement
    uint256[] public agentIds;

    // Mapping of serviceId => staking service info
    mapping(uint256 => ServiceInfo) public mapServiceInfo;
    // Set of currently staking serviceIds
    uint256[] public setServiceIds;

    /// @dev StakingBase initialization.
    /// @param _stakingParams Service staking parameters.
    function initialize(StakingParams memory _stakingParams) external {
        // Double initialization check
        if (serviceRegistry != address(0)) {
            revert AlreadyInitialized();
        }

        // Initial checks
        if (
            _stakingParams.metadataHash == 0 || _stakingParams.maxNumServices == 0
                || _stakingParams.rewardsPerSecond == 0 || _stakingParams.livenessPeriod == 0
                || _stakingParams.timeForEmissions == 0
        ) {
            revert ZeroValue();
        }

        // Check the rest of parameters
        if (_stakingParams.minStakingDeposit < 2) {
            revert LowerThan(_stakingParams.minStakingDeposit, 2);
        }
        if (
            _stakingParams.serviceRegistry == address(0) || _stakingParams.activityChecker == address(0)
                || _stakingParams.serviceRegistryTokenUtility == address(0) || _stakingParams.stakingToken == address(0)
                || _stakingParams.stakingManager == address(0)
        ) {
            revert ZeroAddress();
        }

        // Check for the Activity Checker to be the contract
        if (_stakingParams.activityChecker.code.length == 0) {
            revert ContractOnly(_stakingParams.activityChecker);
        }

        // Assign all the required parameters
        metadataHash = _stakingParams.metadataHash;
        maxNumServices = _stakingParams.maxNumServices;
        rewardsPerSecond = _stakingParams.rewardsPerSecond;
        minStakingDeposit = _stakingParams.minStakingDeposit;
        livenessPeriod = _stakingParams.livenessPeriod;
        timeForEmissions = _stakingParams.timeForEmissions;
        numAgentInstances = 1;
        serviceRegistry = _stakingParams.serviceRegistry;
        activityChecker = _stakingParams.activityChecker;

        // Assign LST specific parameters
        serviceRegistryTokenUtility = _stakingParams.serviceRegistryTokenUtility;
        stakingToken = _stakingParams.stakingToken;
        stakingManager = _stakingParams.stakingManager;

        // Assign agent Ids, if applicable
        uint256 agentId;
        for (uint256 i = 0; i < _stakingParams.agentIds.length; ++i) {
            // Agent Ids must be unique and in ascending order
            if (_stakingParams.agentIds[i] <= agentId) {
                revert WrongAgentId(_stakingParams.agentIds[i]);
            }
            agentId = _stakingParams.agentIds[i];
            agentIds.push(agentId);
        }

        // Calculate emissions amount
        emissionsAmount =
            _stakingParams.rewardsPerSecond * _stakingParams.maxNumServices * _stakingParams.timeForEmissions;

        // Set the checkpoint timestamp to be the deployment one
        tsCheckpoint = block.timestamp;
    }

    /// @dev Checks the ratio pass based on external activity checker implementation.
    /// @param multisig Multisig address.
    /// @param lastNonces Last checked service multisig nonces.
    /// @param ts Time difference between current and last timestamps.
    /// @return ratioPass True, if the defined nonce ratio passes the check.
    /// @return currentNonces Current multisig nonces.
    function _checkRatioPass(address multisig, uint256[] memory lastNonces, uint256 ts)
        internal
        view
        returns (bool ratioPass, uint256[] memory currentNonces)
    {
        // Get current service multisig nonce
        // This is a low level call since it must never revert
        bytes memory activityData = abi.encodeCall(IActivityChecker.getMultisigNonces, multisig);
        (bool success, bytes memory returnData) = activityChecker.staticcall(activityData);

        // If the function call was successful, check the return value
        // The return data length must be the exact number of full slots
        if (success && returnData.length > 63 && (returnData.length % 32 == 0)) {
            // Parse nonces
            currentNonces = abi.decode(returnData, (uint256[]));

            // Get the ratio pass activity check
            activityData = abi.encodeCall(IActivityChecker.isRatioPass, (currentNonces, lastNonces, ts));
            (success, returnData) = activityChecker.staticcall(activityData);

            // The return data must match the size of bool
            if (success && returnData.length == 32) {
                ratioPass = abi.decode(returnData, (bool));
            }
        }
    }

    /// @dev Calculates staking rewards for all services at current timestamp.
    /// @param lastAvailableRewards Available amount of rewards.
    /// @param numServices Number of services eligible for the reward that passed the liveness check.
    /// @param totalRewards Total calculated rewards.
    /// @param eligibleServiceIds Service Ids eligible for rewards.
    /// @param eligibleServiceRewards Corresponding rewards for eligible service Ids.
    /// @param serviceIds All the staking service Ids.
    /// @param serviceNonces Current service nonces.
    function _calculateStakingRewards()
        internal
        view
        returns (
            uint256 lastAvailableRewards,
            uint256 numServices,
            uint256 totalRewards,
            uint256[] memory eligibleServiceIds,
            uint256[] memory eligibleServiceRewards,
            uint256[] memory serviceIds,
            uint256[][] memory serviceNonces
        )
    {
        // Check the last checkpoint timestamp and the liveness period, also check for available rewards to be not zero
        uint256 tsCheckpointLast = tsCheckpoint;
        lastAvailableRewards = availableRewards;

        // Get the service Ids set length
        uint256 size = setServiceIds.length;

        // Carry out rewards calculation logic
        if (size > 0 && block.timestamp - tsCheckpointLast >= livenessPeriod && lastAvailableRewards > 0) {
            // Get necessary arrays
            serviceIds = new uint256[](size);
            eligibleServiceIds = new uint256[](size);
            eligibleServiceRewards = new uint256[](size);
            serviceNonces = new uint256[][](size);

            // Calculate each staked service reward eligibility
            for (uint256 i = 0; i < size; ++i) {
                // Get current service Id
                serviceIds[i] = setServiceIds[i];

                // Get the service info
                ServiceInfo storage sInfo = mapServiceInfo[serviceIds[i]];

                // Calculate the liveness nonce ratio
                // Get the last service checkpoint: staking start time or the global checkpoint timestamp
                uint256 serviceCheckpoint = tsCheckpointLast;
                uint256 ts = sInfo.tsStart;
                // Adjust the service checkpoint time if the service was staking less than the current staking period
                if (ts > serviceCheckpoint) {
                    serviceCheckpoint = ts;
                }

                // Calculate the liveness ratio in 1e18 value
                // This subtraction is always positive or zero, as the last checkpoint is at most block.timestamp
                ts = block.timestamp - serviceCheckpoint;

                bool ratioPass;
                (ratioPass, serviceNonces[i]) = _checkRatioPass(sInfo.multisig, sInfo.nonces, ts);

                // Record the reward for the service if it has provided enough transactions
                if (ratioPass) {
                    // Calculate the reward up until now and record its value for the corresponding service
                    eligibleServiceRewards[numServices] = rewardsPerSecond * ts;
                    totalRewards += eligibleServiceRewards[numServices];
                    eligibleServiceIds[numServices] = serviceIds[i];
                    ++numServices;
                }
            }
        }
    }

    /// @dev Checkpoint to allocate rewards up until a current time.
    /// @return Staking service Ids.
    /// @return Set of reward-eligible service Ids.
    /// @return Corresponding set of reward-eligible service rewards.
    function checkpoint() public returns (uint256[] memory, uint256[] memory, uint256[] memory) {
        // Calculate staking rewards
        (
            uint256 lastAvailableRewards,
            uint256 numServices,
            uint256 totalRewards,
            uint256[] memory eligibleServiceIds,
            uint256[] memory eligibleServiceRewards,
            uint256[] memory serviceIds,
            uint256[][] memory serviceNonces
        ) = _calculateStakingRewards();

        // Get arrays for eligible service Ids and rewards of exact size
        uint256[] memory finalEligibleServiceIds;
        uint256[] memory finalEligibleServiceRewards;
        uint256 curServiceId;

        // If there are eligible services, proceed with staking calculation and update rewards
        if (numServices > 0) {
            finalEligibleServiceIds = new uint256[](numServices);
            finalEligibleServiceRewards = new uint256[](numServices);
            // If total allocated rewards are not enough, adjust the reward value
            if (totalRewards > lastAvailableRewards) {
                // Traverse all the eligible services and adjust their rewards proportional to leftovers
                uint256 updatedReward;
                uint256 updatedTotalRewards;
                for (uint256 i = 1; i < numServices; ++i) {
                    // Calculate the updated reward
                    updatedReward = (eligibleServiceRewards[i] * lastAvailableRewards) / totalRewards;
                    // Add to the total updated reward
                    updatedTotalRewards += updatedReward;
                    // Add reward to the overall service reward
                    curServiceId = eligibleServiceIds[i];
                    finalEligibleServiceIds[i] = eligibleServiceIds[i];
                    finalEligibleServiceRewards[i] = updatedReward;
                    mapServiceInfo[curServiceId].reward += updatedReward;
                }

                // Process the first service in the set
                updatedReward = (eligibleServiceRewards[0] * lastAvailableRewards) / totalRewards;
                updatedTotalRewards += updatedReward;
                curServiceId = eligibleServiceIds[0];
                finalEligibleServiceIds[0] = eligibleServiceIds[0];
                // If the reward adjustment happened to have small leftovers, add it to the first service
                if (lastAvailableRewards > updatedTotalRewards) {
                    updatedReward += lastAvailableRewards - updatedTotalRewards;
                }
                finalEligibleServiceRewards[0] = updatedReward;
                // Add reward to the overall service reward
                mapServiceInfo[curServiceId].reward += updatedReward;
                // Set available rewards to zero
                lastAvailableRewards = 0;
            } else {
                // Traverse all the eligible services and add to their rewards
                for (uint256 i = 0; i < numServices; ++i) {
                    // Add reward to the service overall reward
                    curServiceId = eligibleServiceIds[i];
                    finalEligibleServiceIds[i] = eligibleServiceIds[i];
                    finalEligibleServiceRewards[i] = eligibleServiceRewards[i];
                    mapServiceInfo[curServiceId].reward += eligibleServiceRewards[i];
                }

                // Adjust available rewards
                lastAvailableRewards -= totalRewards;
            }

            // Update the storage value of available rewards
            availableRewards = lastAvailableRewards;
        }

        // If service Ids are returned, then the checkpoint takes place
        if (serviceIds.length > 0) {
            uint256 eCounter = epochCounter;
            // Record service inactivities and updated current service nonces
            for (uint256 i = 0; i < serviceIds.length; ++i) {
                // Get the current service Id
                curServiceId = serviceIds[i];
                // Record service nonces
                mapServiceInfo[curServiceId].nonces = serviceNonces[i];
            }

            // Record the actual epoch length
            uint256 epochLength = block.timestamp - tsCheckpoint;
            // Record the current timestamp such that next calculations start from this point of time
            tsCheckpoint = block.timestamp;

            // Increase the epoch counter
            epochCounter = eCounter + 1;

            emit Checkpoint(
                eCounter, lastAvailableRewards, finalEligibleServiceIds, finalEligibleServiceRewards, epochLength
            );
        }

        // If the checkpoint was not successful, the serviceIds set is not returned and needs to be allocated
        if (serviceIds.length == 0) {
            serviceIds = getServiceIds();
        }

        return (serviceIds, finalEligibleServiceIds, finalEligibleServiceRewards);
    }

    /// @dev Stakes the service.
    /// @param serviceId Service Id.
    function stake(uint256 serviceId) external {
        // Check for stakingManager address
        if (msg.sender != stakingManager) {
            revert UnauthorizedAccount(msg.sender);
        }

        // Checkpoint to finalize any unaccounted rewards, if any
        checkpoint();

        // Get service info
        ServiceInfo storage sInfo = mapServiceInfo[serviceId];
        // tsStart being greater than zero means that the service was not yet unstaked
        if (sInfo.tsStart > 0) {
            revert ServiceNotUnstaked(serviceId);
        }

        // Check for the maximum number of staking services
        uint256 numStakingServices = setServiceIds.length;
        if (numStakingServices == maxNumServices) {
            revert MaxNumServicesReached(maxNumServices);
        }

        // Check the service conditions for staking
        IService.Service memory service = IService(serviceRegistry).getService(serviceId);

        // The service must be deployed
        if (service.state != IService.ServiceState.Deployed) {
            revert WrongServiceState(uint256(service.state), serviceId);
        }

        // Get the service staking token and deposit
        (address token, uint96 stakingDeposit) =
            IService(serviceRegistryTokenUtility).mapServiceIdTokenDeposit(serviceId);

        // The staking token must match the contract token
        if (stakingToken != token) {
            revert WrongStakingToken(stakingToken, token);
        }

        // The staking deposit must be greater or equal to the minimum defined one
        if (stakingDeposit < minStakingDeposit) {
            revert LowerThan(stakingDeposit, minStakingDeposit);
        }

        // ServiceInfo struct will be an empty one since otherwise the safeTransferFrom above would fail
        sInfo.multisig = service.multisig;
        sInfo.owner = msg.sender;
        sInfo.tsStart = block.timestamp;

        // Add the service Id to the set of staked services
        setServiceIds.push(serviceId);

        // Get multisig nonces
        // Use staticcall for view functions to prevent state changes
        bytes memory data = abi.encodeCall(IActivityChecker.getMultisigNonces, (service.multisig));
        (bool success, bytes memory returnData) = activityChecker.staticcall(data);

        uint256[] memory nonces;
        if (success) {
            nonces = abi.decode(returnData, (uint256[]));
        } else {
            // This must never happen
            revert ZeroValue();
        }

        sInfo.nonces = nonces;

        // Transfer the service for staking
        IService(serviceRegistry).safeTransferFrom(msg.sender, address(this), serviceId);

        emit ServiceStaked(epochCounter, serviceId, msg.sender, service.multisig, nonces);
    }

    /// @dev Unstakes the service with collected reward, if available.
    /// @param serviceId Service Id.
    /// @return reward Staking reward.
    function unstake(uint256 serviceId) external returns (uint256 reward) {
        ServiceInfo storage sInfo = mapServiceInfo[serviceId];
        // Check for the service ownership
        if (msg.sender != sInfo.owner) {
            revert OwnerOnly(msg.sender, sInfo.owner);
        }

        // Call the checkpoint
        (uint256[] memory serviceIds,,) = checkpoint();

        // Get the service reward
        reward = sInfo.reward;

        // Get the service index in the set of services
        // The index must always exist as the service is currently staked, otherwise it has no record in the map
        uint256 idx;
        for (; idx < serviceIds.length; ++idx) {
            // Service is still in a global staking set if it is found in the services set
            if (serviceIds[idx] == serviceId) {
                break;
            }
        }

        // This must never happen
        if (idx == serviceIds.length) {
            revert ServiceNotFound(serviceId);
        }

        // Get the unstaked service data
        uint256[] memory nonces = sInfo.nonces;
        address multisig = sInfo.multisig;

        // Clear all the data about the unstaked service
        // Delete the service info struct
        delete mapServiceInfo[serviceId];

        // Update the set of staked service Ids
        // This operation is safe as if the service Id is in set, the set length is at least bigger than one
        uint256 numServicesInSet = setServiceIds.length - 1;
        // Shuffle the last element in set with the removed one, if it is not the last element in the set
        if (numServicesInSet > 0) {
            setServiceIds[idx] = setServiceIds[numServicesInSet];
        }
        setServiceIds.pop();

        // Transfer the service back to the owner
        // Note that the reentrancy is not possible due to the ServiceInfo struct being deleted
        IService(serviceRegistry).transferFrom(address(this), msg.sender, serviceId);

        // Transfer accumulated rewards to the service multisig
        if (reward > 0) {
            _withdraw(multisig, reward);
        }

        emit ServiceUnstaked(epochCounter, serviceId, msg.sender, multisig, nonces, reward, availableRewards);
    }

    /// @dev Claims service rewards with additional checkpoint call.
    /// @param serviceId Service Id.
    /// @return reward Staking reward.
    function claim(uint256 serviceId) external returns (uint256 reward) {
        ServiceInfo storage sInfo = mapServiceInfo[serviceId];
        // Check for the service ownership
        if (msg.sender != sInfo.owner) {
            revert OwnerOnly(msg.sender, sInfo.owner);
        }

        // Call the checkpoint
        checkpoint();

        // Get the claimed service data
        reward = sInfo.reward;

        // Check for the zero reward
        if (reward == 0) {
            revert ZeroValue();
        }

        // Zero the reward field
        sInfo.reward = 0;

        // Transfer accumulated rewards to the service multisig
        // Note that the reentrancy is not possible since the reward is set to zero
        address multisig = sInfo.multisig;
        _withdraw(multisig, reward);

        emit RewardClaimed(epochCounter, serviceId, msg.sender, multisig, sInfo.nonces, reward);
    }

    /// @dev Withdraws the reward amount to a service owner.
    /// @notice The balance is always greater or equal the amount, as follows from the Base contract logic.
    /// @param to Address to.
    /// @param amount Amount to withdraw.
    function _withdraw(address to, uint256 amount) internal {
        // Update the contract balance
        balance -= amount;

        SafeTransferLib.safeTransfer(stakingToken, to, amount);

        emit Withdraw(to, amount);
    }

    /// @dev Deposits funds for staking.
    /// @param amount Token amount to deposit.
    function deposit(uint256 amount) external {
        // Add to the contract and available rewards balances
        uint256 newBalance = balance + amount;
        uint256 newAvailableRewards = availableRewards + amount;

        // Record the new actual balance and available rewards
        balance = newBalance;
        availableRewards = newAvailableRewards;

        // Add to the overall balance
        SafeTransferLib.safeTransferFrom(stakingToken, msg.sender, address(this), amount);

        emit Deposit(msg.sender, amount, newBalance, newAvailableRewards);
    }

    /// @dev Calculates service staking reward starting from the last checkpoint period.
    /// @notice If this function returns a nonzero value, call checkpoint in order to get the full reward.
    /// @param serviceId Service Id.
    /// @return reward Service reward for the on-going epoch.
    function calculateStakingLastReward(uint256 serviceId) public view returns (uint256 reward) {
        // Calculate overall staking rewards
        (
            uint256 lastAvailableRewards,
            uint256 numServices,
            uint256 totalRewards,
            uint256[] memory eligibleServiceIds,
            uint256[] memory eligibleServiceRewards,,
        ) = _calculateStakingRewards();

        // If there are eligible services, proceed with staking calculation and update rewards for the service Id
        for (uint256 i = 0; i < numServices; ++i) {
            // Get the service index in the eligible service set and calculate its latest reward
            if (eligibleServiceIds[i] == serviceId) {
                // If total allocated rewards are not enough, adjust the reward value
                if (totalRewards > lastAvailableRewards) {
                    reward = (eligibleServiceRewards[i] * lastAvailableRewards) / totalRewards;
                } else {
                    reward = eligibleServiceRewards[i];
                }
                break;
            }
        }
    }

    /// @dev Calculates overall service staking reward at current timestamp.
    /// @param serviceId Service Id.
    /// @return reward Service reward.
    function calculateStakingReward(uint256 serviceId) external view returns (uint256 reward) {
        // Get current service reward
        ServiceInfo memory sInfo = mapServiceInfo[serviceId];
        reward = sInfo.reward;

        // Add pending reward
        reward += calculateStakingLastReward(serviceId);
    }

    /// @dev Gets the service staking state.
    /// @param serviceId.
    /// @return stakingState Staking state of the service.
    function getStakingState(uint256 serviceId) external view returns (StakingState stakingState) {
        ServiceInfo memory sInfo = mapServiceInfo[serviceId];
        if (sInfo.tsStart > 0) {
            stakingState = StakingState.Staked;
        }
    }

    /// @dev Gets the next reward checkpoint timestamp.
    /// @return tsNext Next reward checkpoint timestamp.
    function getNextRewardCheckpointTimestamp() external view returns (uint256 tsNext) {
        // Last checkpoint timestamp plus the liveness period
        tsNext = tsCheckpoint + livenessPeriod;
    }

    /// @dev Gets staked service info.
    /// @param serviceId Service Id.
    /// @return sInfo Struct object with the corresponding service info.
    function getServiceInfo(uint256 serviceId) external view returns (ServiceInfo memory sInfo) {
        sInfo = mapServiceInfo[serviceId];
    }

    /// @dev Gets staked service Ids.
    /// @return Staked service Ids.
    function getServiceIds() public view returns (uint256[] memory) {
        return setServiceIds;
    }

    /// @dev Gets number of staked service Ids.
    /// @return Number of staked service Ids.
    function getNumServiceIds() public view returns (uint256) {
        return setServiceIds.length;
    }
}
