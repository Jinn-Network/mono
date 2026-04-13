// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC721TokenReceiver} from "../registries/ERC721TokenReceiver.sol";
import {Implementation, OwnerOnly, ZeroAddress} from "./Implementation.sol";
import {IService} from "./interfaces/IService.sol";
import {IStaking} from "./interfaces/IStaking.sol";
import {IToken, INFToken} from "./interfaces/IToken.sol";

// Collector interface
interface ICollector {
    /// @dev Tops up address(this) with a specified amount according to a selected operation.
    /// @param amount OLAS amount.
    /// @param operation Operation type.
    function topUpBalance(uint256 amount, bytes32 operation) external;

    /// @dev Tops up address(this) with a specified amount for protocol assets.
    /// @param amount OLAS amount.
    function topUpProtocol(uint256 amount) external;
}

// Safe multi send interface
interface IMultiSend {
    /// @dev Sends multiple transactions and reverts all if one fails.
    /// @param transactions Encoded transactions. Each transaction is encoded as a packed bytes of
    ///                     operation has to be uint8(0) in this version (=> 1 byte),
    ///                     to as a address (=> 20 bytes),
    ///                     value as a uint256 (=> 32 bytes),
    ///                     payload length as a uint256 (=> 32 bytes),
    ///                     payload as bytes.
    ///                     see abi.encodePacked for more information on packed encoding
    /// @notice The code is for most part the same as the normal MultiSend (to keep compatibility),
    ///         but reverts if a transaction tries to use a delegatecall.
    /// @notice This method is payable as delegatecalls keep the msg.value from the previous call
    ///         If the calling method (e.g. execTransaction) received ETH this would revert otherwise
    function multiSend(bytes memory transactions) external payable;
}

// Recovery Module interface
interface IRecoveryModule {
    /// @dev Recovers service multisig access for a specified service Id.
    /// @param serviceId Service Id.
    function recoverAccess(uint256 serviceId) external;
}

// Generic Safe interface
interface ISafe {
    enum Operation {
        Call,
        DelegateCall
    }

    /// @dev Allows to add a module to the whitelist.
    /// @param module Module to be whitelisted.
    function enableModule(address module) external;

    /// @dev Allows to execute a Safe transaction confirmed by required number of owners and then pays the account that submitted the transaction.
    /// @param to Destination address of Safe transaction.
    /// @param value Ether value of Safe transaction.
    /// @param data Data payload of Safe transaction.
    /// @param operation Operation type of Safe transaction.
    /// @param safeTxGas Gas that should be used for the Safe transaction.
    /// @param baseGas Gas costs that are independent of the transaction execution(e.g. base transaction fee, signature check, payment of the refund)
    /// @param gasPrice Gas price that should be used for the payment calculation.
    /// @param gasToken Token address (or 0 if ETH) that is used for the payment.
    /// @param refundReceiver Address of receiver of gas payment (or 0 if tx.origin).
    /// @param signatures Packed signature data ({bytes32 r}{bytes32 s}{uint8 v})
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);

    /// @dev Allows a Module to execute a Safe transaction without any further confirmations.
    /// @param to Destination address of module transaction.
    /// @param value Ether value of module transaction.
    /// @param data Data payload of module transaction.
    /// @param operation Operation type of module transaction.
    function execTransactionFromModule(address to, uint256 value, bytes memory data, Operation operation)
        external
        returns (bool success);

    /// @dev Allows to swap/replace an owner from the Safe with another address.
    ///      This can only be done via a Safe transaction.
    /// @notice Replaces the owner `oldOwner` in the Safe with `newOwner`.
    /// @param prevOwner Owner that pointed to the owner to be replaced in the linked list
    /// @param oldOwner Owner address to be replaced.
    /// @param newOwner New owner address.
    function swapOwner(address prevOwner, address oldOwner, address newOwner) external;

    /// @dev Sets guard that checks transactions before and after execution.
    /// @param guard Guard address.
    function setGuard(address guard) external;
}

// SafeMultisigWithRecoveryModule interface
interface ISafeMultisigWithRecoveryModule {
    /// @dev Creates a Safe multisig.
    /// @param owners Set of multisig owners.
    /// @param threshold Number of required confirmations for a multisig transaction.
    /// @param data Encoded data related to the creation of a chosen multisig.
    /// @return multisig Address of a created multisig.
    function create(address[] memory owners, uint256 threshold, bytes memory data) external returns (address multisig);

    /// @dev Gets recovery module address.
    function recoveryModule() external view returns (address);
}

/// @dev Zero value.
error ZeroValue();

/// @dev The contract is already initialized.
error AlreadyInitialized();

/// @dev Wrong length of arrays.
error WrongArrayLength();

/// @dev Value overflow.
/// @param provided Overflow value.
/// @param max Maximum possible value.
error Overflow(uint256 provided, uint256 max);

/// @dev Account is unauthorized.
/// @param account Account address.
error UnauthorizedAccount(address account);

/// @dev Caught reentrancy violation.
error ReentrancyGuard();

/// @dev Execution has failed.
/// @param target Target address.
/// @param payload Payload data.
error ExecutionFailed(address target, bytes payload);

/// @dev Staking type is not supported.
/// @param stakingType Staking type.
error UnsupportedStakingType(uint8 stakingType);

/// @title ExternalStakingDistributor - Smart contract for distributing OLAS across external staking contracts
contract ExternalStakingDistributor is Implementation, ERC721TokenReceiver {
    // Staking type enum
    enum StakingType {
        STAKING_TYPE_OLAS_V1,
        STAKING_TYPE_OLAS_V2
    }

    event StakingProcessorL2Updated(address indexed l2StakingProcessor);
    event MultisigGuardUpdated(address indexed guard);
    event ExternalServiceStaked(
        address indexed sender,
        address indexed stakingProxy,
        uint256 indexed serviceId,
        uint256 agentId,
        bytes32 configHash,
        uint256 stakingDeposit,
        uint256 stakedBalance
    );
    event ExternalServiceUnstaked(
        address indexed sender,
        address indexed stakingProxy,
        uint256 indexed serviceId,
        uint256 stakingDeposit,
        uint256 stakedBalance
    );
    event ExternalServiceRestaked(address indexed sender, address indexed stakingProxy, uint256 indexed serviceId);
    event Deployed(uint256 indexed serviceId, address indexed multisig);
    event RewardsDistributed(
        uint256 indexed serviceId,
        address indexed multisig,
        uint256 collectorAmount,
        uint256 protocolAmount,
        uint256 curatingAgentAmount
    );
    event SetStakingProxyConfigs(address[] stakingProxies, uint256[] proxyTypes);
    event SetManagingAgentStatuses(address[] managingAgents, bool[] statuses);
    event SetCuratingAgentStatuses(
        address indexed stakingGuard, address indexed stakingProxy, address[] managingAgents, bool[] statuses
    );
    event Deposit(address indexed sender, bytes32 indexed operation, uint256 amount);
    event Withdraw(address indexed sender, bytes32 indexed operation, uint256 amount, uint256 unstakeRequestedAmount);
    event Claimed(address[] stakingProxies, uint256[] serviceIds, uint256[] rewards);
    event NativeTokenReceived(uint256 amount);

    // Staking Manager version
    string public constant VERSION = "0.1.0";
    // Reward transfer operation
    bytes32 public constant REWARD = 0x0b9821ae606ebc7c79bf3390bdd3dc93e1b4a7cda27aad60646e7b88ff55b001;

    // Number of agent instances
    uint256 public constant NUM_AGENT_INSTANCES = 1;
    // Threshold
    uint256 public constant THRESHOLD = 1;
    // Max reward factor: 10k is enough to handle 0..100.00% with a step of 0.01%
    uint256 public constant MAX_REWARD_FACTOR = 10_000;

    // Service manager address
    address public immutable serviceManager;
    // OLAS token address
    address public immutable olas;
    // Service registry address
    address public immutable serviceRegistry;
    // Service registry token utility address
    address public immutable serviceRegistryTokenUtility;
    // Safe multisig with recovery module processing contract address
    address public immutable safeMultisigWithRecoveryModule;
    // Recovery module contract address
    address public immutable recoveryModule;
    // Safe same address multisig processing contract address
    address public immutable safeSameAddressMultisig;
    // Safe fallback handler address
    address public immutable fallbackHandler;
    // Multisend contract address
    address public immutable multiSend;
    // OLAS collector address
    address public immutable collector;

    // Staked balance
    uint256 public stakedBalance;
    // L2 staking processor address
    address public l2StakingProcessor;
    // Multisig guard address
    address public guard;

    // Nonce
    uint256 internal _nonce;
    // Reentrancy lock
    uint256 internal _locked = 1;

    // Mapping of whitelisted staking proxy address => (staking reward distributions | staking type)
    // Staking config: stakingGuard 160 bits | collectorRewardFactor 16 bits | protocolRewardFactor 16 bits
    //                 | curatingAgentRewardFactor 16 bits | stakingType 8 bits
    mapping(address => uint256) public mapStakingProxyConfigs;
    // Mapping of unstake requests: unstake operation => amount requested
    mapping(bytes32 => uint256) public mapUnstakeOperationRequestedAmounts;
    // Mapping of service Id => agent address curating it
    mapping(uint256 => address) public mapServiceIdCuratingAgents;
    // UNUSED for now: Mapping whitelisted curating agent addresses
    mapping(address => bool) public mapCuratingAgents;
    // Mapping of whitelisted managing agent addresses
    mapping(address => bool) public mapManagingAgents;
    // Mapping of multisig address => service Id
    mapping(address => uint256) public mapMultisigServiceIds;

    // Mapping of (staking guard + staking proxy) hash => whitelisted curating agent addresses
    mapping(bytes32 => mapping(address => bool)) public mapStakingGuardHashCuratingAgents;

    /// @dev ExternalStakingDistributor constructor.
    /// @param _olas OLAS token address.
    /// @param _serviceManager Service manager address.
    /// @param _safeMultisigWithRecoveryModule Safe multisig with recovery module processing contract address.
    /// @param _safeSameAddressMultisig Safe same address multisig processing contract address.
    /// @param _fallbackHandler Safe fallback handler address.
    /// @param _multiSend Multisend contract address.
    /// @param _collector OLAS collector address.
    constructor(
        address _olas,
        address _serviceManager,
        address _safeMultisigWithRecoveryModule,
        address _safeSameAddressMultisig,
        address _fallbackHandler,
        address _multiSend,
        address _collector
    ) {
        // Check for zero addresses
        if (
            _olas == address(0) || _serviceManager == address(0) || _safeMultisigWithRecoveryModule == address(0)
                || _safeSameAddressMultisig == address(0) || _fallbackHandler == address(0) || _multiSend == address(0)
                || _collector == address(0)
        ) {
            revert ZeroAddress();
        }

        olas = _olas;
        serviceManager = _serviceManager;
        safeMultisigWithRecoveryModule = _safeMultisigWithRecoveryModule;
        safeSameAddressMultisig = _safeSameAddressMultisig;
        fallbackHandler = _fallbackHandler;
        multiSend = _multiSend;
        collector = _collector;
        serviceRegistry = IService(serviceManager).serviceRegistry();
        serviceRegistryTokenUtility = IService(serviceManager).serviceRegistryTokenUtility();
        recoveryModule = ISafeMultisigWithRecoveryModule(_safeMultisigWithRecoveryModule).recoveryModule();
    }

    /// @dev Initializes external staking distributor.
    function initialize() external {
        if (owner != address(0)) {
            revert AlreadyInitialized();
        }

        owner = msg.sender;
    }

    /// @dev Changes staking processor L2 address.
    /// @param newStakingProcessorL2 New staking processor L2 address.
    function changeStakingProcessorL2(address newStakingProcessorL2) external {
        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Check for zero address
        if (newStakingProcessorL2 == address(0)) {
            revert ZeroAddress();
        }

        l2StakingProcessor = newStakingProcessorL2;
        emit StakingProcessorL2Updated(newStakingProcessorL2);
    }

    /// @dev Changes multisig guard address.
    /// @param newGuard New multisig guard address.
    function changeMultisigGuard(address newGuard) external {
        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Check for zero address
        if (newGuard == address(0)) {
            revert ZeroAddress();
        }

        guard = newGuard;
        emit MultisigGuardUpdated(newGuard);
    }

    /// @dev Creates multisig and enables address(this) as module.
    /// @param agentInstance Agent instance address.
    /// @return multisig Created multisig address.
    function _createMultisigWithSelfAsModule(address agentInstance) internal returns (address multisig) {
        // Prepare Safe multisig data
        uint256 localNonce = _nonce;
        uint256 randomNonce = uint256(keccak256(abi.encodePacked(block.timestamp, msg.sender, localNonce)));
        bytes memory data = abi.encode(fallbackHandler, randomNonce);

        // Update global nonce
        _nonce = localNonce + 1;

        // Create Safe with self as owner
        address[] memory owners = new address[](1);
        owners[0] = address(this);
        multisig = ISafeMultisigWithRecoveryModule(safeMultisigWithRecoveryModule).create(owners, THRESHOLD, data);

        // Encode enable module (external staking distributor) function call
        data = abi.encodeCall(ISafe.enableModule, (address(this)));
        // MultiSend payload with the packed data of (operation, multisig address, value(0), payload length, payload)
        bytes memory msPayload = abi.encodePacked(ISafe.Operation.Call, multisig, uint256(0), data.length, data);

        // Encode enable module (guard) function call
        data = abi.encodeCall(ISafe.enableModule, (guard));
        // MultiSend payload with the packed data of (operation, multisig address, value(0), payload length, payload)
        msPayload =
            bytes.concat(msPayload, abi.encodePacked(ISafe.Operation.Call, multisig, uint256(0), data.length, data));

        // Encode set guard function call
        data = abi.encodeCall(ISafe.setGuard, (guard));
        // MultiSend payload with the packed data of (operation, multisig address, value(0), payload length, payload)
        msPayload =
            bytes.concat(msPayload, abi.encodePacked(ISafe.Operation.Call, multisig, uint256(0), data.length, data));

        // Encode swap owner function call
        data = abi.encodeCall(ISafe.swapOwner, (address(0x1), address(this), agentInstance));
        // Concatenate multi send payload with the packed data of (operation, multisig address, value(0), payload length, payload)
        msPayload =
            bytes.concat(msPayload, abi.encodePacked(ISafe.Operation.Call, multisig, uint256(0), data.length, data));

        // Multisend call to execute all the payloads
        msPayload = abi.encodeCall(IMultiSend.multiSend, (msPayload));

        // Construct signature for contract execution
        bytes32 r = bytes32(uint256(uint160(address(this))));
        bytes memory signature = abi.encodePacked(r, bytes32(0), uint8(1));

        // Execute multisig transaction
        bool success = ISafe(multisig)
            .execTransaction(
                multiSend,
                0,
                msPayload,
                ISafe.Operation.DelegateCall,
                0,
                0,
                0,
                address(0),
                payable(address(0)),
                signature
            );

        // Check for success
        if (!success) {
            revert ExecutionFailed(multiSend, msPayload);
        }
    }

    /// @dev Creates and / or (re-)deploys service and stakes it.
    /// @param stakingProxy Staking proxy address.
    /// @param minStakingDeposit Min staking deposit value.
    /// @param serviceId Service Id.
    /// @param agentId Agent Blueprint Id.
    /// @param configHash Config hash.
    /// @param agentInstance Agent instance address.
    function _deployAndStake(
        address stakingProxy,
        uint256 minStakingDeposit,
        uint256 serviceId,
        uint256 agentId,
        bytes32 configHash,
        address agentInstance
    ) internal returns (uint256) {
        // Get service creation flag
        bool createService = serviceId > 0 ? false : true;

        // Set agent params
        IService.AgentParams[] memory agentParams = new IService.AgentParams[](NUM_AGENT_INSTANCES);
        agentParams[0] = IService.AgentParams(uint32(NUM_AGENT_INSTANCES), uint96(minStakingDeposit));

        // Get agent Ids
        uint32[] memory agentIds = new uint32[](NUM_AGENT_INSTANCES);
        agentIds[0] = uint32(agentId);

        // Set agent instances as [agentInstance]
        address[] memory instances = new address[](NUM_AGENT_INSTANCES);
        instances[0] = agentInstance;

        if (createService) {
            // Create a service owned by this contract
            serviceId = IService(serviceManager)
                .create(address(this), olas, configHash, agentIds, agentParams, uint32(THRESHOLD));
        } else {
            // Update service owned by this contract
            IService(serviceManager).update(olas, configHash, agentIds, agentParams, uint32(THRESHOLD), serviceId);
        }

        // Activate registration (1 wei as a deposit wrapper)
        IService(serviceManager).activateRegistration{value: 1}(serviceId);

        // Register msg.sender as an agent instance (numAgentInstances wei as a bond wrapper)
        IService(serviceManager).registerAgents{value: NUM_AGENT_INSTANCES}(serviceId, instances, agentIds);

        address multisig;
        if (createService) {
            // Create multisig with address(this) as module and swap owners to agentInstance
            multisig = _createMultisigWithSelfAsModule(agentInstance);

            // Link mutlsig and service Id
            mapMultisigServiceIds[multisig] = serviceId;

            // Deploy service via same address multisig
            IService(serviceManager).deploy(serviceId, safeSameAddressMultisig, abi.encodePacked(multisig));
        } else {
            // Re-deploy service via recovery module
            multisig = IService(serviceManager).deploy(serviceId, recoveryModule, abi.encode(serviceId));
        }

        emit Deployed(serviceId, multisig);

        // Approve service NFT for staking instance
        INFToken(serviceRegistry).approve(stakingProxy, serviceId);

        // Stake service
        IStaking(stakingProxy).stake(serviceId);

        return serviceId;
    }

    /// @dev Distributes rewards.
    /// @param stakingProxy Staking proxy address.
    /// @param serviceId Service Id.
    /// @param reward Service reward.
    function _distributeRewards(address stakingProxy, uint256 serviceId, uint256 reward) internal {
        // Get service multisig
        (, address multisig,,,,,) = IService(serviceRegistry).mapServices(serviceId);

        // Get service curating agent address
        address curatingAgent = mapServiceIdCuratingAgents[serviceId];

        // Sanity checks
        if (multisig == address(0) || curatingAgent == address(0)) {
            revert ZeroAddress();
        }

        // Get proxy config value
        uint256 config = mapStakingProxyConfigs[stakingProxy];

        // Unwrap config
        (, uint256 collectorAmount, uint256 protocolAmount,, StakingType stakingType) = unwrapStakingConfig(config);

        // Calculate reward distribution
        collectorAmount = (reward * collectorAmount) / MAX_REWARD_FACTOR;
        protocolAmount = (reward * protocolAmount) / MAX_REWARD_FACTOR;
        uint256 fullCollectorAmount = collectorAmount + protocolAmount;
        uint256 curatingAgentAmount = reward - fullCollectorAmount;

        // Check staking type to define transfer operations
        if (stakingType == StakingType.STAKING_TYPE_OLAS_V1) {
            // Reward is on multisig

            // Encode OLAS approve function call for collector
            bytes memory data = abi.encodeCall(IToken.approve, (collector, fullCollectorAmount));
            // MultiSend payload with the packed data of (operation, multisig address, value(0), payload length, payload)
            bytes memory msPayload = abi.encodePacked(ISafe.Operation.Call, olas, uint256(0), data.length, data);

            // Encode collector top-up function call for REWARD operation
            data = abi.encodeCall(ICollector.topUpBalance, (collectorAmount, REWARD));
            // Concatenate multi send payload with the packed data of (operation, multisig address, value(0), payload length, payload)
            msPayload = bytes.concat(
                msPayload, abi.encodePacked(ISafe.Operation.Call, collector, uint256(0), data.length, data)
            );

            // Check for protocol amount
            if (protocolAmount > 0) {
                // Encode collector top-up function call for protocol assets
                data = abi.encodeCall(ICollector.topUpProtocol, (protocolAmount));
                // Concatenate multi send payload with the packed data of (operation, multisig address, value(0), payload length, payload)
                msPayload = bytes.concat(
                    msPayload, abi.encodePacked(ISafe.Operation.Call, collector, uint256(0), data.length, data)
                );
            }

            // Check for curating agent amount
            if (curatingAgentAmount > 0) {
                // Encode OLAS transfer function call for curating agent
                data = abi.encodeCall(IToken.transfer, (curatingAgent, curatingAgentAmount));
                // Concatenate multi send payload with the packed data of (operation, multisig address, value(0), payload length, payload)
                msPayload = bytes.concat(
                    msPayload, abi.encodePacked(ISafe.Operation.Call, olas, uint256(0), data.length, data)
                );
            }

            // Multisend call to execute all the payloads
            msPayload = abi.encodeCall(IMultiSend.multiSend, (msPayload));

            // Execute module call
            bool success =
                ISafe(multisig).execTransactionFromModule(multiSend, 0, msPayload, ISafe.Operation.DelegateCall);

            // Check for success
            if (!success) {
                revert ExecutionFailed(multiSend, msPayload);
            }
        } else if (stakingType == StakingType.STAKING_TYPE_OLAS_V2) {
            // Reward is already on address(this)

            // Approve olas for collector
            IToken(olas).approve(collector, fullCollectorAmount);
            // Collector top-up function call for REWARD operation
            ICollector(collector).topUpBalance(collectorAmount, REWARD);

            // Check for protocol amount
            if (protocolAmount > 0) {
                ICollector(collector).topUpProtocol(protocolAmount);
            }

            // Check for curating agent amount
            if (curatingAgentAmount > 0) {
                IToken(olas).transfer(curatingAgent, curatingAgentAmount);
            }
        } else {
            // This must never happen
            revert UnsupportedStakingType(uint8(stakingType));
        }

        emit RewardsDistributed(serviceId, multisig, collectorAmount, protocolAmount, curatingAgentAmount);
    }

    /// @dev Stakes OLAS into specified staking proxy contract if balance is enough for staking.
    /// @param stakingProxy Staking proxy address.
    /// @param serviceId Service Id: non-zero if service is owned by address(this) and could be reused, zero otherwise.
    /// @param agentId Agent Blueprint Id.
    /// @param configHash Config hash.
    /// @param agentInstance Agent instance address.
    function stake(address stakingProxy, uint256 serviceId, uint256 agentId, bytes32 configHash, address agentInstance)
        external
    {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Get proxy config value
        uint256 config = mapStakingProxyConfigs[stakingProxy];

        // Check for whitelisted staking proxy type
        if (config == 0) {
            revert ZeroValue();
        }

        // If staker is not owner - check for curating agent access
        if (msg.sender != owner) {
            // Curating agent access is true, if not set otherwise
            bool curatingAgentAccess = true;

            // Get staking guard address
            (address stakingGuard,,,,) = unwrapStakingConfig(config);

            // Check for msg.sender access
            if (stakingGuard != address(0)) {
                // Get staking hash
                bytes32 stakingHash = keccak256(abi.encode(stakingGuard, stakingProxy));
                // Check access
                curatingAgentAccess = mapStakingGuardHashCuratingAgents[stakingHash][msg.sender];
            }

            // Check for access: whitelisted curating agent
            if (!curatingAgentAccess) {
                revert UnauthorizedAccount(msg.sender);
            }
        }

        // Check for zero value
        if (configHash == 0) {
            revert ZeroValue();
        }

        // Check for agent Id
        if (agentId == 0) {
            // If zero - fetch it from stakingProxy
            uint256[] memory agentIds = IStaking(stakingProxy).getAgentIds();

            // Check for length
            if (agentIds.length == 0) {
                revert ZeroValue();
            }

            // Assign agent Id
            agentId = agentIds[0];

            // This must never happen if staking proxy is setup correctly
            if (agentId == 0) {
                revert ZeroValue();
            }
        }

        // Get current unstaked balance
        uint256 balance = IToken(olas).balanceOf(address(this));
        uint256 minStakingDeposit = IStaking(stakingProxy).minStakingDeposit();
        // Note: for now max number of agent instances is 1
        uint256 fullStakingDeposit = minStakingDeposit * (1 + NUM_AGENT_INSTANCES);

        // Check for balance
        if (fullStakingDeposit > balance) {
            revert Overflow(fullStakingDeposit, balance);
        }

        // Get current staked balance and update it
        uint256 localStakedBalance = stakedBalance + fullStakingDeposit;
        stakedBalance = localStakedBalance;

        // Approve token for the serviceRegistryTokenUtility contract
        IToken(olas).approve(serviceRegistryTokenUtility, fullStakingDeposit);

        serviceId = _deployAndStake(stakingProxy, minStakingDeposit, serviceId, agentId, configHash, agentInstance);

        // Record service curating agent
        mapServiceIdCuratingAgents[serviceId] = msg.sender;

        emit ExternalServiceStaked(
            msg.sender, stakingProxy, serviceId, agentId, configHash, fullStakingDeposit, localStakedBalance
        );

        _locked = 1;
    }

    /// @dev Unstakes, if needed, and withdraws specified amounts from specified staking contracts.
    /// @param stakingProxy Staking proxy address.
    /// @param serviceId Service Id.
    /// @param operation Unstake operation type.
    function unstakeAndWithdraw(address stakingProxy, uint256 serviceId, bytes32 operation) external {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Get staking proxy available rewards amount
        uint256 availableRewards = IStaking(stakingProxy).availableRewards();

        // Check if service is evicted
        IStaking.StakingState stakingState = IStaking(stakingProxy).getStakingState(serviceId);

        // Check for unstaked state
        if (stakingState == IStaking.StakingState.Unstaked) {
            revert ZeroValue();
        }

        // Check for zero rewards balance and access: whitelisted managing agent or owner
        // msg.sender does not matter if rewards are no longer available, or if the service is evicted
        if (
            stakingState == IStaking.StakingState.Staked && availableRewards > 0
                && !(mapManagingAgents[msg.sender] || msg.sender == owner)
        ) {
            revert UnauthorizedAccount(msg.sender);
        }

        // Check if service unstake is requested
        if (stakingProxy != address(0) && serviceId > 0) {
            // Calculate how many unstakes are needed
            uint256 minStakingDeposit = IStaking(stakingProxy).minStakingDeposit();
            uint256 fullStakingDeposit = minStakingDeposit * (1 + NUM_AGENT_INSTANCES);

            // Get current staked balance
            uint256 localStakedBalance = stakedBalance;

            // This must never happen because of how it was setup in first place
            if (fullStakingDeposit > localStakedBalance) {
                revert Overflow(fullStakingDeposit, localStakedBalance);
            }

            // Update staked balance
            localStakedBalance -= fullStakingDeposit;
            stakedBalance = localStakedBalance;

            // Unstake, terminate and unbond service
            uint256 reward = IStaking(stakingProxy).unstake(serviceId);
            IService(serviceManager).terminate(serviceId);
            IService(serviceManager).unbond(serviceId);

            // Pass access to address(this)
            IRecoveryModule(recoveryModule).recoverAccess(serviceId);

            if (reward > 0) {
                // Distribute leftover rewards, if not zero
                _distributeRewards(stakingProxy, serviceId, reward);
            }

            // Clear curating agent since service is unstaked, terminated and unbonded
            delete mapServiceIdCuratingAgents[serviceId];

            emit ExternalServiceUnstaked(msg.sender, stakingProxy, serviceId, fullStakingDeposit, localStakedBalance);
        }

        // Get current unstake requested amount
        uint256 unstakeRequestedAmount = mapUnstakeOperationRequestedAmounts[operation];

        // Check if requested amount is not zero
        if (unstakeRequestedAmount > 0) {
            // Get current balance
            uint256 amount = IToken(olas).balanceOf(address(this));
            // Check for zero balance
            if (amount == 0) {
                revert ZeroValue();
            }

            // Check if OLAS balance is not enough to cover requested unstake operation amount
            if (unstakeRequestedAmount > amount) {
                unstakeRequestedAmount -= amount;
                // Update unstake requested amount
                mapUnstakeOperationRequestedAmounts[operation] = unstakeRequestedAmount;
            } else {
                amount = unstakeRequestedAmount;
                mapUnstakeOperationRequestedAmounts[operation] = 0;
            }

            // Approve OLAS for collector to initiate L1 transfer for corresponding operation later by agents / operators
            IToken(olas).approve(collector, amount);

            // Request top-up by Collector for a specific unstake operation
            ICollector(collector).topUpBalance(amount, operation);

            emit Withdraw(msg.sender, operation, amount, unstakeRequestedAmount);
        }

        _locked = 1;
    }

    /// @dev Re-stakes evicted specified service Id.
    /// @param stakingProxy Staking proxy address.
    /// @param serviceId Service Id.
    function reStake(address stakingProxy, uint256 serviceId) external {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Check for zero address
        if (stakingProxy == address(0)) {
            revert ZeroAddress();
        }

        // Check for zero value
        if (serviceId == 0) {
            revert ZeroValue();
        }

        // Check if service is evicted
        IStaking.StakingState stakingState = IStaking(stakingProxy).getStakingState(serviceId);

        // Check for evicted state
        if (stakingState != IStaking.StakingState.Evicted) {
            revert ZeroValue();
        }

        // Check for access: curating agent or managing agent, or owner
        if (!(mapCuratingAgents[msg.sender] || mapManagingAgents[msg.sender] || msg.sender == owner)) {
            revert UnauthorizedAccount(msg.sender);
        }

        // Unstake service
        uint256 reward = IStaking(stakingProxy).unstake(serviceId);

        if (reward > 0) {
            // Distribute leftover rewards, if not zero
            _distributeRewards(stakingProxy, serviceId, reward);
        }

        // Approve service NFT for re-staking
        INFToken(serviceRegistry).approve(stakingProxy, serviceId);

        // Stake service
        IStaking(stakingProxy).stake(serviceId);

        emit ExternalServiceRestaked(msg.sender, stakingProxy, serviceId);

        _locked = 1;
    }

    /// @dev Sets staking proxy types.
    /// @param stakingProxies Set of staking proxies.
    /// @param configs Corresponding set of staking configs.
    function setStakingProxyConfigs(address[] memory stakingProxies, uint256[] memory configs) external {
        // Check for the ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Get number of proxies
        uint256 numProxies = stakingProxies.length;
        // Check for array length
        if (numProxies == 0 || numProxies != configs.length) {
            revert WrongArrayLength();
        }

        // Traverse staking proxies
        for (uint256 i = 0; i < numProxies; ++i) {
            // Check for zero address
            if (stakingProxies[i] == address(0)) {
                revert ZeroAddress();
            }

            // Check for zero value
            if (configs[i] == 0) {
                revert ZeroValue();
            }

            // Check proxy configs
            (, uint256 collectorRewardFactor, uint256 protocolRewardFactor, uint256 curatingAgentRewardFactor,) =
                unwrapStakingConfig(configs[i]);

            // Check for collector and zero value
            if (collectorRewardFactor == 0) {
                revert ZeroValue();
            }

            // Check for total factor to be equal to MAX_REWARD_FACTOR (100%)
            uint256 totalFactor = collectorRewardFactor + protocolRewardFactor + curatingAgentRewardFactor;
            if (totalFactor != MAX_REWARD_FACTOR) {
                revert Overflow(totalFactor, MAX_REWARD_FACTOR);
            }

            mapStakingProxyConfigs[stakingProxies[i]] = configs[i];
        }

        emit SetStakingProxyConfigs(stakingProxies, configs);
    }

    /// @dev Sets managing agents statuses.
    /// @notice This is required such that unstake does not happen without a reason.
    /// @param managingAgents Set of managing agents.
    /// @param statuses Corresponding set of statuses: true / false.
    function setManagingAgents(address[] memory managingAgents, bool[] memory statuses) external {
        // Check for the ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Get number of agents
        uint256 numAgents = managingAgents.length;
        // Check for array length
        if (numAgents == 0 || numAgents != statuses.length) {
            revert WrongArrayLength();
        }

        // Traverse managing agents
        for (uint256 i = 0; i < numAgents; ++i) {
            // Check for zero address
            if (managingAgents[i] == address(0)) {
                revert ZeroAddress();
            }

            mapManagingAgents[managingAgents[i]] = statuses[i];
        }

        emit SetManagingAgentStatuses(managingAgents, statuses);
    }

    /// @dev Sets curating agents statuses.
    /// @notice This is required such that potential malicious agents do not stake for no reason.
    /// @notice Contract owner sets stakingProxy config, however this function call is for staking guards only.
    /// @param stakingProxy Staking proxy address.
    /// @param curatingAgents Set of curating agents.
    /// @param statuses Corresponding set of statuses: true / false.
    function setCuratingAgents(address stakingProxy, address[] memory curatingAgents, bool[] memory statuses) external {
        // Get number of agents
        uint256 numAgents = curatingAgents.length;
        // Check for array length
        if (numAgents == 0 || numAgents != statuses.length) {
            revert WrongArrayLength();
        }

        // Get proxy config value
        uint256 config = mapStakingProxyConfigs[stakingProxy];

        // Check for whitelisted staking proxy type
        if (config == 0) {
            revert ZeroValue();
        }

        // Get staking guard address
        (address stakingGuard,,,,) = unwrapStakingConfig(config);

        // Check for access: only staking guard
        if (msg.sender != stakingGuard) {
            revert UnauthorizedAccount(msg.sender);
        }

        // Traverse curating agents
        for (uint256 i = 0; i < numAgents; ++i) {
            // Check for zero address
            if (curatingAgents[i] == address(0)) {
                revert ZeroAddress();
            }

            // Encode staking hash
            bytes32 stakingHash = keccak256(abi.encode(stakingGuard, stakingProxy));
            // Set curating agent status
            mapStakingGuardHashCuratingAgents[stakingHash][curatingAgents[i]] = statuses[i];
        }

        emit SetCuratingAgentStatuses(stakingGuard, stakingProxy, curatingAgents, statuses);
    }

    /// @dev Deposits OLAS for further staking.
    /// @param amount OLAS amount.
    /// @param operation Stake operation type.
    function deposit(uint256 amount, bytes32 operation) external {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Check for l2StakingProcessor to be a sender
        if (msg.sender != l2StakingProcessor) {
            revert UnauthorizedAccount(msg.sender);
        }

        // Get OLAS from l2StakingProcessor or any other account
        IToken(olas).transferFrom(msg.sender, address(this), amount);

        emit Deposit(msg.sender, operation, amount);

        _locked = 1;
    }

    /// @dev Requests withdraw via specified unstake operation, and request to add to unstake amount, if required.
    /// @param amount Specified unstake amount.
    /// @param operation Unstake operation type.
    function withdrawAndRequestUnstake(uint256 amount, bytes32 operation) external {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Check for l2StakingProcessor to be a sender
        if (msg.sender != l2StakingProcessor) {
            revert UnauthorizedAccount(msg.sender);
        }

        // Get current OLAS balance
        uint256 olasBalance = IToken(olas).balanceOf(address(this));
        // Get current staked balance
        uint256 localStakedBalance = stakedBalance;
        // Get overall amount
        uint256 totalBalance = olasBalance + localStakedBalance;

        // Check for overflow: this must never happen as checks are done on L1 side
        if (amount > totalBalance) {
            revert Overflow(amount, totalBalance);
        }

        uint256 unstakeRequestedAmount;

        // Check if OLAS balance is not enough to cover withdraw request
        if (amount > olasBalance) {
            unstakeRequestedAmount = amount - olasBalance;
            amount = olasBalance;

            mapUnstakeOperationRequestedAmounts[operation] += unstakeRequestedAmount;
        }

        // Check for zero amount
        if (amount > 0) {
            // Approve OLAS for collector to initiate L1 transfer for corresponding operation later by agents / operators
            IToken(olas).approve(collector, amount);

            // Request top-up by Collector for a specific unstake operation
            ICollector(collector).topUpBalance(amount, operation);
        }

        emit Withdraw(msg.sender, operation, amount, unstakeRequestedAmount);

        _locked = 1;
    }

    /// @dev Claims specified service rewards.
    /// @param stakingProxies Set of staking proxy addresses.
    /// @param serviceIds Corresponding set if service Ids.
    /// @return rewards Set of staking rewards.
    function claim(address[] memory stakingProxies, uint256[] memory serviceIds)
        external
        returns (uint256[] memory rewards)
    {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Get number of proxies
        uint256 numProxies = stakingProxies.length;
        // Check for correct array length
        if (numProxies == 0 || serviceIds.length != numProxies) {
            revert WrongArrayLength();
        }

        // Allocate rewards array
        rewards = new uint256[](numProxies);

        // Claim rewards
        for (uint256 i = 0; i < numProxies; ++i) {
            // Check for zero address
            if (stakingProxies[i] == address(0)) {
                revert ZeroAddress();
            }

            // Claim reward (use checkpointAndClaim for OLAS V2 staking contracts
            // that separate checkpoint() and claim() — claim() alone reverts with
            // ZeroValue if checkpoint already distributed the reward)
            rewards[i] = IStaking(stakingProxies[i]).checkpointAndClaim(serviceIds[i]);
        }

        // Distribute rewards
        for (uint256 i = 0; i < numProxies; ++i) {
            if (rewards[i] > 0) {
                _distributeRewards(stakingProxies[i], serviceIds[i], rewards[i]);
            }
        }

        emit Claimed(stakingProxies, serviceIds, rewards);

        _locked = 1;
    }

    /// @dev Wraps staking proxy config: reward factors and staking type value.
    /// @param stakingGuard Staking proxy proposer address.
    /// @param collectorRewardFactor Collector reward factor.
    /// @param protocolRewardFactor Protocol reward factor.
    /// @param curatingAgentRewardFactor Curating agent reward factor.
    /// @param stakingType Staking type.
    function wrapStakingConfig(
        address stakingGuard,
        uint256 collectorRewardFactor,
        uint256 protocolRewardFactor,
        uint256 curatingAgentRewardFactor,
        StakingType stakingType
    ) public pure returns (uint256 config) {
        // Staking config: collectorRewardFactor 16 bits | protocolRewardFactor 16 bits
        //                 | curatingAgentRewardFactor 16 bits | stakingType 8 bits
        config = uint8(stakingType) | curatingAgentRewardFactor << 8 | protocolRewardFactor << 24
            | collectorRewardFactor << 40 | uint160(stakingGuard) << 56;
    }

    /// @dev Unwraps staking proxy config: reward factors and staking type value.
    /// @param config Staking proxy config value.
    /// @return stakingGuard Staking proxy proposer address.
    /// @return collectorRewardFactor Collector reward factor.
    /// @return protocolRewardFactor Protocol reward factor.
    /// @return curatingAgentRewardFactor Curating agent reward factor.
    /// @return stakingType Staking type.
    function unwrapStakingConfig(uint256 config)
        public
        pure
        returns (
            address stakingGuard,
            uint256 collectorRewardFactor,
            uint256 protocolRewardFactor,
            uint256 curatingAgentRewardFactor,
            StakingType stakingType
        )
    {
        // Staking config: stakingGuard 160 bits | collectorRewardFactor 16 bits | protocolRewardFactor 16 bits
        //                 | curatingAgentRewardFactor 16 bits | stakingType 8 bits
        stakingGuard = address(uint160(config >> 56));
        collectorRewardFactor = uint16(config >> 40);
        protocolRewardFactor = uint16(config >> 24);
        curatingAgentRewardFactor = uint16(config >> 8);
        stakingType = StakingType(uint8(config));
    }

    /// @dev Receives native funds for mock Service Registry minimal payments.
    receive() external payable {
        emit NativeTokenReceived(msg.value);
    }
}
