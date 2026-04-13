// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC721TokenReceiver} from "../../registries/ERC721TokenReceiver.sol";
import {BeaconProxy} from "../BeaconProxy.sol";
import {Implementation, OwnerOnly, ZeroAddress} from "../Implementation.sol";
import {IService} from "../interfaces/IService.sol";
import {IStaking} from "../interfaces/IStaking.sol";
import {IToken, INFToken} from "../interfaces/IToken.sol";

interface ICollector {
    /// @dev Tops up address(this) with a specified amount according to a selected operation.
    /// @param amount OLAS amount.
    /// @param operation Operation type.
    function topUpBalance(uint256 amount, bytes32 operation) external;

    /// @dev Re-balances unstake reserve to direct it to requested operation.
    /// @param stakingProxy Staking proxy address.
    /// @param amount Amount value.
    /// @param operation Operation type.
    function rebalanceFromUnstakeReserve(address stakingProxy, uint256 amount, bytes32 operation) external;
}

// Activity module interface
interface IActivityModule {
    /// @dev Initializes activity module proxy.
    /// @param _multisig Service multisig address.
    /// @param _stakingProxy Staking proxy address.
    /// @param _serviceId Service Id.
    function initialize(address _multisig, address _stakingProxy, uint256 _serviceId) external;

    /// @dev Increases initial module activity.
    function increaseInitialActivity() external;

    /// @dev Drains unclaimed rewards after service unstake.
    /// @return balance Amount drained.
    function drain() external returns (uint256 balance);
}

/// @dev Zero value.
error ZeroValue();

/// @dev The contract is already initialized.
error AlreadyInitialized();

/// @dev Value overflow.
/// @param provided Overflow value.
/// @param max Maximum possible value.
error Overflow(uint256 provided, uint256 max);

/// @dev Account is unauthorized.
/// @param account Account address.
error UnauthorizedAccount(address account);

/// @dev Caught reentrancy violation.
error ReentrancyGuard();

/// @title StakingManager - Smart contract for OLAS staking management
contract StakingManager is Implementation, ERC721TokenReceiver {
    event StakingProcessorL2Updated(address indexed l2StakingProcessor);
    event StakingBalanceUpdated(
        bytes32 indexed operation, address indexed stakingProxy, uint256 numStakes, uint256 balance
    );
    event Staked(address indexed stakingProxy, uint256 indexed serviceId, address activityModule);
    event Unstaked(address indexed stakingProxy, uint256 indexed serviceId, address activityModule);
    event CreatedAndDeployed(uint256 indexed serviceId, address indexed multisig, address indexed activityModule);
    event ReDeployed(uint256 indexed serviceId, address indexed multisig, address indexed activityModule);
    event Claimed(
        address indexed stakingProxy, uint256 indexed serviceId, address indexed activityModule, uint256 reward
    );
    event NativeTokenReceived(uint256 amount);

    // Staking Manager version
    string public constant VERSION = "0.1.0";

    // Number of agent instances
    uint256 public constant NUM_AGENT_INSTANCES = 1;
    // Threshold
    uint256 public constant THRESHOLD = 1;

    // LST agent Id
    uint256 public immutable agentId;
    // LST service config hash
    bytes32 public immutable configHash;
    // Service manager address
    address public immutable serviceManager;
    // OLAS token address
    address public immutable olas;
    // Service registry address
    address public immutable serviceRegistry;
    // Service registry token utility address
    address public immutable serviceRegistryTokenUtility;
    // Staking factory address
    address public immutable stakingFactory;
    /// Safe module initializer address
    address public immutable safeModuleInitializer;
    // OLAS collector address
    address public immutable collector;
    // Activity module beacon address
    address public immutable beacon;
    // SafeL2 address
    address public immutable safeL2;

    // Safe multisig processing contract address
    address public safeMultisig;
    // Safe same address multisig processing contract address
    address public safeSameAddressMultisig;
    // Safe fallback handler
    address public fallbackHandler;
    // L2 staking processor address
    address public l2StakingProcessor;

    // Nonce
    uint256 internal _nonce;
    // Reentrancy lock
    uint256 internal _locked = 1;

    // Mapping of staking proxy address => current balance
    mapping(address => uint256) public mapStakingProxyBalances;
    // Mapping of staking proxy address => set of staked service Ids
    mapping(address => uint256[]) public mapStakedServiceIds;
    // Mapping of service Id => activity module proxy address
    mapping(uint256 => address) public mapServiceIdActivityModules;
    // Mapping of staking proxy address => last staked service Id index in mapStakedServiceIds corresponding set
    mapping(address => uint256) public mapLastStakedServiceIdxs;

    /// @dev StakingManager constructor.
    /// @param _olas OLAS token address.
    /// @param _serviceManager Service manager address.
    /// @param _stakingFactory Staking factory address.
    /// @param _safeModuleInitializer Safe module initializer address.
    /// @param _safeL2 SafeL2 contract address.
    /// @param _beacon Activity module beacon.
    /// @param _collector OLAS collector address.
    /// @param _agentId LST agent Id.
    /// @param _configHash LST service config hash.
    constructor(
        address _olas,
        address _serviceManager,
        address _stakingFactory,
        address _safeModuleInitializer,
        address _safeL2,
        address _beacon,
        address _collector,
        uint256 _agentId,
        bytes32 _configHash
    ) {
        // Check for zero addresses
        if (
            _olas == address(0) || _serviceManager == address(0) || _stakingFactory == address(0)
                || _safeModuleInitializer == address(0) || _safeL2 == address(0) || _beacon == address(0)
                || _collector == address(0)
        ) {
            revert ZeroAddress();
        }

        // Check for zero values
        if (_agentId == 0 || _configHash == 0) {
            revert ZeroValue();
        }

        agentId = _agentId;
        configHash = _configHash;

        olas = _olas;
        serviceManager = _serviceManager;
        stakingFactory = _stakingFactory;
        safeModuleInitializer = _safeModuleInitializer;
        safeL2 = _safeL2;
        beacon = _beacon;
        collector = _collector;
        serviceRegistry = IService(serviceManager).serviceRegistry();
        serviceRegistryTokenUtility = IService(serviceManager).serviceRegistryTokenUtility();
    }

    /// @dev Initializes staking manager.
    /// @param _safeMultisig Safe multisig contract address.
    /// @param _safeSameAddressMultisig Safe same address multisig contract address.
    /// @param _fallbackHandler Fallback handler for service multisigs.
    function initialize(address _safeMultisig, address _safeSameAddressMultisig, address _fallbackHandler) external {
        if (owner != address(0)) {
            revert AlreadyInitialized();
        }

        if (_safeMultisig == address(0) || _safeSameAddressMultisig == address(0) || _fallbackHandler == address(0)) {
            revert ZeroAddress();
        }

        safeMultisig = _safeMultisig;
        safeSameAddressMultisig = _safeSameAddressMultisig;
        fallbackHandler = _fallbackHandler;

        owner = msg.sender;
    }

    /// @dev Changes staking processor L2 address.
    /// @param newStakingProcessorL2 New staking processor L2 address.
    function changeStakingProcessorL2(address newStakingProcessorL2) external {
        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Check for the zero address
        if (newStakingProcessorL2 == address(0)) {
            revert ZeroAddress();
        }

        l2StakingProcessor = newStakingProcessorL2;
        emit StakingProcessorL2Updated(newStakingProcessorL2);
    }

    /// @dev Creates and deploys a service.
    /// @param token Staking token address.
    /// @param minStakingDeposit Min staking deposit value.
    /// @return serviceId Minted service Id.
    /// @return multisig Service multisig.
    function _createAndDeploy(address token, uint256 minStakingDeposit)
        internal
        returns (uint256 serviceId, address multisig, address activityModule)
    {
        // Set agent params
        IService.AgentParams[] memory agentParams = new IService.AgentParams[](NUM_AGENT_INSTANCES);
        agentParams[0] = IService.AgentParams(uint32(NUM_AGENT_INSTANCES), uint96(minStakingDeposit));

        // Set agent Ids
        uint32[] memory agentIds = new uint32[](NUM_AGENT_INSTANCES);
        agentIds[0] = uint32(agentId);

        // Set agent instances as [msg.sender]
        address[] memory instances = new address[](NUM_AGENT_INSTANCES);

        // Create activity module proxy
        BeaconProxy activityModuleProxy = new BeaconProxy(beacon);
        // Assign address as agent instance
        activityModule = address(activityModuleProxy);
        instances[0] = activityModule;

        // Create a service owned by this contract
        serviceId =
            IService(serviceManager).create(address(this), token, configHash, agentIds, agentParams, uint32(THRESHOLD));

        // Record activity module
        mapServiceIdActivityModules[serviceId] = instances[0];

        // Activate registration (1 wei as a deposit wrapper)
        IService(serviceManager).activateRegistration{value: 1}(serviceId);

        // Register msg.sender as an agent instance (numAgentInstances wei as a bond wrapper)
        IService(serviceManager).registerAgents{value: NUM_AGENT_INSTANCES}(serviceId, instances, agentIds);

        // Prepare Safe multisig data
        uint256 localNonce = _nonce;
        uint256 randomNonce = uint256(keccak256(abi.encodePacked(block.timestamp, msg.sender, localNonce)));
        // Safe module payload
        bytes memory safeModulePayload = abi.encodeWithSignature("setupToL2(address)", safeL2);
        bytes memory data = abi.encodePacked(
            safeModuleInitializer, fallbackHandler, address(0), address(0), uint256(0), randomNonce, safeModulePayload
        );

        // Deploy the service
        multisig = IService(serviceManager).deploy(serviceId, safeMultisig, data);

        // Update the nonce
        _nonce = localNonce + 1;
    }

    /// @dev Stakes the already deployed service.
    /// @param stakingProxy Staking proxy address.
    /// @param serviceId Service Id.
    /// @param activityModule Activity module address.
    function _stake(address stakingProxy, uint256 serviceId, address activityModule) internal {
        // Approve service NFT for the staking instance
        INFToken(serviceRegistry).approve(stakingProxy, serviceId);

        // Stake the service
        IStaking(stakingProxy).stake(serviceId);

        // Increase initial module activity
        IActivityModule(activityModule).increaseInitialActivity();

        emit Staked(stakingProxy, serviceId, activityModule);
    }

    /// @dev Creates and deploys a service, and stakes it with a specified staking contract.
    /// @notice The service cannot be registered again if it is currently staked.
    /// @param stakingProxy Corresponding staking instance address.
    function _createAndStake(address stakingProxy, uint256 minStakingDeposit) internal {
        // Create and deploy service
        (uint256 serviceId, address multisig, address activityModule) = _createAndDeploy(olas, minStakingDeposit);

        // Initialize activity module
        IActivityModule(activityModule).initialize(multisig, stakingProxy, serviceId);

        // Stake the service
        _stake(stakingProxy, serviceId, activityModule);

        // Push new service into its corresponding set
        mapStakedServiceIds[stakingProxy].push(serviceId);

        emit CreatedAndDeployed(serviceId, multisig, activityModule);
    }

    /// @dev Stakes the already deployed service.
    /// @param stakingProxy Staking proxy address.
    /// @param serviceId Service Id.
    function _deployAndStake(address stakingProxy, uint256 serviceId) internal {
        // Get the service multisig
        (, address multisig,,,,,) = IService(serviceRegistry).mapServices(serviceId);

        // Activate registration (1 wei as a deposit wrapper)
        IService(serviceManager).activateRegistration{value: 1}(serviceId);

        // Get multisig instances = activityModule
        address[] memory instances = new address[](NUM_AGENT_INSTANCES);
        instances[0] = mapServiceIdActivityModules[serviceId];
        // Get agent Ids
        uint32[] memory agentIds = new uint32[](NUM_AGENT_INSTANCES);
        agentIds[0] = uint32(agentId);

        // Register msg.sender as an agent instance (numAgentInstances wei as a bond wrapper)
        IService(serviceManager).registerAgents{value: NUM_AGENT_INSTANCES}(serviceId, instances, agentIds);

        // Re-deploy the service
        bytes memory data = abi.encodePacked(multisig);
        IService(serviceManager).deploy(serviceId, safeSameAddressMultisig, data);

        // Stake the service
        _stake(stakingProxy, serviceId, instances[0]);

        emit ReDeployed(serviceId, multisig, instances[0]);
    }

    /// @dev Stakes OLAS into specified staking proxy contract if deposit + balance is enough for staking.
    /// @param stakingProxy Staking proxy address.
    /// @param amount OLAS amount.
    /// @param operation Stake operation type.
    function stake(address stakingProxy, uint256 amount, bytes32 operation) external virtual {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Check for StakingProcessor access
        if (msg.sender != l2StakingProcessor) {
            revert UnauthorizedAccount(msg.sender);
        }

        // Get OLAS from l2StakingProcessor
        IToken(olas).transferFrom(l2StakingProcessor, address(this), amount);

        // Get current unstaked balance
        uint256 balance = mapStakingProxyBalances[stakingProxy];
        uint256 minStakingDeposit = IStaking(stakingProxy).minStakingDeposit();
        uint256 fullStakingDeposit = minStakingDeposit * (1 + NUM_AGENT_INSTANCES);

        // Add amount to current unstaked balance
        balance += amount;

        // Calculate number of stakes
        uint256 numStakes = balance / fullStakingDeposit;
        uint256 totalStakingDeposit = numStakes * fullStakingDeposit;
        // Check if the balance is enough to create another stake
        if (numStakes > 0) {
            // Approve token for the serviceRegistryTokenUtility contract
            IToken(olas).approve(serviceRegistryTokenUtility, totalStakingDeposit);

            // Get already existent service or create a new one
            uint256 nextIdx = mapLastStakedServiceIdxs[stakingProxy];
            uint256 maxIdx = mapStakedServiceIds[stakingProxy].length;

            // Check for the first service Id to be ever staked
            if (maxIdx == 0) {
                // Insert blanc service Id
                mapStakedServiceIds[stakingProxy].push(0);
            }

            // Traverse all required stakes
            for (uint256 i = 0; i < numStakes; ++i) {
                // Next index must always be bigger than the last one staked
                nextIdx++;

                if (nextIdx < maxIdx) {
                    // Deploy and stake already existent service or create a new one first
                    uint256 serviceId = mapStakedServiceIds[stakingProxy][nextIdx];
                    _deployAndStake(stakingProxy, serviceId);
                } else {
                    _createAndStake(stakingProxy, minStakingDeposit);
                }
            }
            // Update last staked service Id
            mapLastStakedServiceIdxs[stakingProxy] = nextIdx;

            // Update unstaked balance
            balance -= totalStakingDeposit;
        }

        mapStakingProxyBalances[stakingProxy] = balance;

        emit StakingBalanceUpdated(operation, stakingProxy, numStakes, balance);

        _locked = 1;
    }

    /// @dev Unstakes, if needed, and withdraws specified amounts from specified staking contracts.
    /// @notice Unstakes services if needed to satisfy withdraw requests.
    ///         Call this to unstake definitely terminated staking contracts - deactivated on L1 and / or ran out of funds.
    ///         The majority of discovered chains does not need any value to process token bridge transfer.
    /// @param stakingProxy Staking proxy address.
    /// @param amount Unstake amount.
    /// @param operation Unstake operation type.
    function unstake(address stakingProxy, uint256 amount, bytes32 operation) external virtual {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Check for l2StakingProcessor to be a sender
        if (msg.sender != l2StakingProcessor) {
            revert UnauthorizedAccount(msg.sender);
        }

        // Get current unstaked balance
        uint256 balance = mapStakingProxyBalances[stakingProxy];
        uint256 numUnstakes;
        if (balance >= amount) {
            balance -= amount;
        } else {
            // This must never happen except for unlikely cases where L2 staking setup does not correspond L1 numbers,
            // or when stake failed and now symmetrical unstakes take place
            if (mapLastStakedServiceIdxs[stakingProxy] == 0) {
                // Get amount - balance difference
                uint256 amountDiff = amount - balance;
                // Amount becomes balance
                amount = balance;
                // Balance drops to zero since it was not sufficient in first places
                balance = 0;

                // Request funds re-balance from unstake reserve
                ICollector(collector).rebalanceFromUnstakeReserve(stakingProxy, amountDiff, operation);
            } else {
                // Calculate how many unstakes are needed
                uint256 minStakingDeposit = IStaking(stakingProxy).minStakingDeposit();
                uint256 fullStakingDeposit = minStakingDeposit * (1 + NUM_AGENT_INSTANCES);
                // Subtract unstaked balance
                uint256 balanceDiff = amount - balance;

                // Calculate number of stakes
                numUnstakes = balanceDiff / fullStakingDeposit;
                // Depending of how much is unstaked, adjust the unstaked balance
                if (balanceDiff % fullStakingDeposit == 0) {
                    balance = 0;
                } else {
                    numUnstakes++;
                    balance = numUnstakes * fullStakingDeposit - balanceDiff;
                }

                // Get the last staked Service Id index
                uint256 lastIdx = mapLastStakedServiceIdxs[stakingProxy];
                // This must never happen
                if (numUnstakes > lastIdx) {
                    revert Overflow(numUnstakes, lastIdx);
                }

                // Traverse all required unstakes
                for (uint256 i = 0; i < numUnstakes; ++i) {
                    uint256 serviceId = mapStakedServiceIds[stakingProxy][lastIdx];
                    // Unstake, terminate and unbond the service
                    IStaking(stakingProxy).unstake(serviceId);
                    IService(serviceManager).terminate(serviceId);
                    IService(serviceManager).unbond(serviceId);

                    // Get activityModule
                    address activityModule = mapServiceIdActivityModules[serviceId];
                    // Drain funds, if anything is left on a multisig
                    IActivityModule(activityModule).drain();

                    lastIdx--;

                    emit Unstaked(stakingProxy, serviceId, activityModule);
                }

                // Update last staked service Id
                mapLastStakedServiceIdxs[stakingProxy] = lastIdx;
            }
        }

        emit StakingBalanceUpdated(operation, stakingProxy, numUnstakes, balance);

        // Update staking balance
        mapStakingProxyBalances[stakingProxy] = balance;

        // Amount can be zero only if L2 and L1 balances are incorrectly setup (see condition above)
        if (amount > 0) {
            // Approve OLAS for collector to initiate L1 transfer for corresponding operation later by agents / operators
            IToken(olas).approve(collector, amount);

            // Request top-up by Collector for a specific unstake operation
            ICollector(collector).topUpBalance(amount, operation);
        }

        _locked = 1;
    }

    /// @dev Claims specified service rewards.
    /// @param stakingProxy Staking proxy address.
    /// @param serviceId Service Id.
    /// @return reward Staking reward.
    function claim(address stakingProxy, uint256 serviceId) external returns (uint256 reward) {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Check that msg.sender is a valid Activity Module corresponding to its service Id
        address activityModule = mapServiceIdActivityModules[serviceId];
        if (msg.sender != activityModule) {
            revert UnauthorizedAccount(msg.sender);
        }

        reward = IStaking(stakingProxy).claim(serviceId);

        emit Claimed(stakingProxy, serviceId, activityModule, reward);

        _locked = 1;
    }

    /// @dev Gets staked service Ids for a specific staking proxy.
    /// @param stakingProxy Staking proxy address.
    /// @return serviceIds Set of service Ids.
    function getStakedServiceIds(address stakingProxy) external view returns (uint256[] memory serviceIds) {
        // Get last staked service index
        uint256 lastStakedServiceIdx = mapLastStakedServiceIdxs[stakingProxy];

        // Check if services for specified staking proxy have been initialized, otherwise no services have been created
        if (lastStakedServiceIdx > 0) {
            // Get all service Ids ever created for the staking proxy
            uint256[] memory allServiceIds = mapStakedServiceIds[stakingProxy];

            // Allocated staked service Ids
            serviceIds = new uint256[](lastStakedServiceIdx);

            for (uint256 i = 0; i < lastStakedServiceIdx; ++i) {
                serviceIds[i] = allServiceIds[i + 1];
            }
        }
    }

    /// @dev Receives native funds for mock Service Registry minimal payments.
    receive() external payable {
        emit NativeTokenReceived(msg.value);
    }
}
