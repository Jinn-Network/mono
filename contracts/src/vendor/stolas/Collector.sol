// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Implementation, OwnerOnly, ZeroAddress} from "./Implementation.sol";

interface IBridge {
    function relayToL1(address to, uint256 olasAmount, bytes memory bridgePayload) external payable;
}

// ERC20 token interface
interface IToken {
    /// @dev Sets `amount` as the allowance of `spender` over the caller's tokens.
    /// @param spender Account address that will be able to transfer tokens on behalf of the caller.
    /// @param amount Token amount.
    /// @return True if the function execution is successful.
    function approve(address spender, uint256 amount) external returns (bool);

    /// @dev Transfers the token amount.
    /// @param to Address to transfer to.
    /// @param amount The amount to transfer.
    /// @return True if the function execution is successful.
    function transfer(address to, uint256 amount) external returns (bool);

    /// @dev Transfers the token amount that was previously approved up until the maximum allowance.
    /// @param from Account address to transfer from.
    /// @param to Account address to transfer to.
    /// @param amount Amount to transfer to.
    /// @return True if the function execution is successful.
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev Zero value.
error ZeroValue();

/// @dev The contract is already initialized.
error AlreadyInitialized();

/// @dev Value overflow.
/// @param provided Overflow value.
/// @param max Maximum possible value.
error Overflow(uint256 provided, uint256 max);

/// @dev Wrong length of arrays.
error WrongArrayLength();

/// @dev Wrong sender account address.
/// @param sender Sender account.
error WrongAccount(address sender);

/// @dev Caught reentrancy violation.
error ReentrancyGuard();

// ReceiverBalance struct
struct ReceiverBalance {
    uint256 balance;
    address receiver;
}

/// @title Collector - Smart contract for collecting staking rewards
contract Collector is Implementation {
    event StakingManagerUpdated(address indexed stakingManager);
    event StakingProcessorUpdated(address indexed stakingProcessorL2);
    event OperationReceiversSet(bytes32[] operations, address[] receivers);
    event OperationReceiverBalancesUpdated(bytes32 indexed operation, address indexed receiver, uint256 balance);
    event StakingProxyUnstakeReserveUpdated(address indexed sender, address indexed stakingProxy, uint256 amount);
    event ProtocolFactorUpdated(uint256 protocolFactor);
    event ProtocolBalanceUpdated(uint256 protocolBalance);
    event TokensRelayed(address indexed l1Distributor, uint256 amount);

    // Reward transfer operation
    bytes32 public constant REWARD = 0x0b9821ae606ebc7c79bf3390bdd3dc93e1b4a7cda27aad60646e7b88ff55b001;
    // Min olas balance to relay
    uint256 public constant MIN_OLAS_BALANCE = 1 ether;
    // Max protocol factor
    uint256 public constant MAX_PROTOCOL_FACTOR = 10_000;

    // OLAS contract address
    address public immutable olas;

    // Protocol balance
    uint256 public protocolBalance;
    // Protocol factor in 10_000 value
    uint256 public protocolFactor;
    // Staking manager address
    address public stakingManager;
    // L2 staking processor address
    address public l2StakingProcessor;

    // Reentrancy lock
    uint256 internal _locked = 1;

    // Mapping of operation => OLAS balance and L1 address to send to
    mapping(bytes32 => ReceiverBalance) public mapOperationReceiverBalances;
    // Mapping of staking proxy => unsuccessful stake amount
    mapping(address => uint256) public mapStakingProxyUnstakeReserves;

    /// @param _olas OLAS address on L2.
    constructor(address _olas) {
        olas = _olas;
    }

    /// @dev Initializes collector.
    function initialize() external {
        if (owner != address(0)) {
            revert AlreadyInitialized();
        }

        owner = msg.sender;
    }

    /// @dev Changes staking manager address.
    /// @param newStakingManager New staking processor L2 address.
    function changeStakingManager(address newStakingManager) external {
        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        if (newStakingManager == address(0)) {
            revert ZeroAddress();
        }

        stakingManager = newStakingManager;
        emit StakingManagerUpdated(newStakingManager);
    }

    /// @dev Changes staking processor L2 address.
    /// @param newStakingProcessorL2 New staking processor L2 address.
    function changeStakingProcessorL2(address newStakingProcessorL2) external {
        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        if (newStakingProcessorL2 == address(0)) {
            revert ZeroAddress();
        }

        l2StakingProcessor = newStakingProcessorL2;
        emit StakingProcessorUpdated(newStakingProcessorL2);
    }

    /// @dev Changes protocol factor value.
    /// @param newProtocolFactor New protocol factor value.
    function changeProtocolFactor(uint256 newProtocolFactor) external {
        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        protocolFactor = newProtocolFactor;
        emit ProtocolFactorUpdated(newProtocolFactor);
    }

    /// @dev Sets receiver addresses according operation type.
    /// @param operations Operation types.
    /// @param receivers Corresponding receiver addresses.
    function setOperationReceivers(bytes32[] memory operations, address[] memory receivers) external {
        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Check array lengths
        if (operations.length == 0 || operations.length != receivers.length) {
            revert WrongArrayLength();
        }

        // Traverse all array elements
        for (uint256 i = 0; i < operations.length; ++i) {
            // Check for zero value
            if (operations[i] == 0) {
                revert ZeroValue();
            }

            // Check for zero address
            if (receivers[i] == address(0)) {
                revert ZeroAddress();
            }

            // Record L1 receiver addresses
            ReceiverBalance storage receiverBalance = mapOperationReceiverBalances[operations[i]];
            receiverBalance.receiver = receivers[i];
        }

        emit OperationReceiversSet(operations, receivers);
    }

    /// @dev Tops up address(this) with a specified amount for protocol assets.
    /// @param amount OLAS amount.
    function topUpProtocol(uint256 amount) external {
        // Reentrancy guard
        if (_locked == 2) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Pull OLAS amount
        IToken(olas).transferFrom(msg.sender, address(this), amount);

        // Update protocol balance
        uint256 curProtocolBalance = protocolBalance + amount;
        protocolBalance = curProtocolBalance;

        emit ProtocolBalanceUpdated(curProtocolBalance);

        _locked = 1;
    }

    /// @dev Tops up address(this) with a specified amount according to a selected operation.
    /// @param amount OLAS amount.
    /// @param operation Operation type.
    function topUpBalance(uint256 amount, bytes32 operation) external {
        // Reentrancy guard
        if (_locked == 2) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Get ReceiverBalance struct according to the operation type
        ReceiverBalance storage receiverBalance = mapOperationReceiverBalances[operation];

        // Get receiver address
        address receiver = receiverBalance.receiver;
        // Check for zero address
        if (receiverBalance.receiver == address(0)) {
            revert ZeroAddress();
        }

        // Pull OLAS amount and increase corresponding balance
        IToken(olas).transferFrom(msg.sender, address(this), amount);
        uint256 balance = receiverBalance.balance + amount;
        receiverBalance.balance = balance;

        emit OperationReceiverBalancesUpdated(operation, receiver, balance);

        _locked = 1;
    }

    /// @dev Tops up address(this) with a specified amount as staking proxy unstake reserve.
    /// @param stakingProxy Staking proxy address.
    /// @param amount OLAS amount.
    function topUpUnstakeReserve(address stakingProxy, uint256 amount) external {
        // Reentrancy guard
        if (_locked == 2) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Check for correct access
        if (msg.sender != l2StakingProcessor) {
            revert WrongAccount(msg.sender);
        }

        // Pull OLAS amount and increase corresponding balance
        IToken(olas).transferFrom(msg.sender, address(this), amount);

        // Record balance change
        uint256 stakingProxyBalance = mapStakingProxyUnstakeReserves[stakingProxy] + amount;
        mapStakingProxyUnstakeReserves[stakingProxy] = stakingProxyBalance;

        emit StakingProxyUnstakeReserveUpdated(msg.sender, stakingProxy, stakingProxyBalance);

        _locked = 1;
    }

    /// @dev Re-balances unstake reserve to direct it to requested operation.
    /// @param stakingProxy Staking proxy address.
    /// @param amount Amount value.
    /// @param operation Operation type.
    function rebalanceFromUnstakeReserve(address stakingProxy, uint256 amount, bytes32 operation) external {
        // Reentrancy guard
        if (_locked == 2) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Check for correct access
        if (msg.sender != stakingManager) {
            revert WrongAccount(msg.sender);
        }

        // Get staking proxy unstake balance
        uint256 proxyUnstakeBalance = mapStakingProxyUnstakeReserves[stakingProxy];

        // Check for overflow
        if (amount > proxyUnstakeBalance) {
            revert Overflow(amount, proxyUnstakeBalance);
        }

        // Record proxy unstake balance change
        proxyUnstakeBalance -= amount;
        mapStakingProxyUnstakeReserves[stakingProxy] = proxyUnstakeBalance;

        // Get ReceiverBalance struct according to the operation type
        ReceiverBalance storage receiverBalance = mapOperationReceiverBalances[operation];
        // Get receiver address
        address receiver = receiverBalance.receiver;
        // Check for zero address
        if (receiverBalance.receiver == address(0)) {
            revert ZeroAddress();
        }

        // Record L1 receiver balance change
        uint256 updatedBalance = receiverBalance.balance + amount;
        receiverBalance.balance = updatedBalance;

        emit StakingProxyUnstakeReserveUpdated(msg.sender, stakingProxy, proxyUnstakeBalance);
        emit OperationReceiverBalancesUpdated(operation, receiver, updatedBalance);

        _locked = 1;
    }

    /// @dev Relays tokens to L1.
    /// @param operation Operation type related to L1 receiver.
    /// @param bridgePayload Bridge payload.
    function relayTokens(bytes32 operation, bytes memory bridgePayload) external payable {
        // Reentrancy guard
        if (_locked == 2) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Get ReceiverBalance struct according to the operation type
        ReceiverBalance storage receiverBalance = mapOperationReceiverBalances[operation];

        // Get receiver address
        address receiver = receiverBalance.receiver;
        // Check for zero address
        if (receiver == address(0)) {
            revert ZeroAddress();
        }

        // Get OLAS balance
        uint256 olasBalance = receiverBalance.balance;
        // Check for minimum balance
        if (olasBalance < MIN_OLAS_BALANCE) {
            revert ZeroValue();
        }

        // Rewards are subject to a protocol fee, if applicable
        if (operation == REWARD) {
            uint256 curProtocolFactor = protocolFactor;

            // Skip if protocol factor is zero
            if (curProtocolFactor > 0) {
                uint256 protocolAmount = (olasBalance * protocolFactor) / MAX_PROTOCOL_FACTOR;
                olasBalance -= protocolAmount;

                // Update protocol balance
                uint256 curProtocolBalance = protocolBalance + protocolAmount;
                protocolBalance = curProtocolBalance;

                emit ProtocolBalanceUpdated(curProtocolBalance);
            }
        }

        // Zero operation balance
        receiverBalance.balance = 0;

        emit TokensRelayed(receiver, olasBalance);

        // Approve tokens for staking processor
        IToken(olas).approve(l2StakingProcessor, olasBalance);

        // Send tokens to L1
        IBridge(l2StakingProcessor).relayToL1{value: msg.value}(receiver, olasBalance, bridgePayload);

        _locked = 1;
    }

    /// @dev Funds external address.
    /// @param account Account address.
    /// @param amount Amount value.
    function fundExternal(address account, uint256 amount) external {
        // Reentrancy guard
        if (_locked == 2) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Get current protocol balance
        uint256 curProtocolBalance = protocolBalance;

        // Check for overflow
        if (amount > curProtocolBalance) {
            revert Overflow(amount, curProtocolBalance);
        }

        // Update protocol balance
        curProtocolBalance -= amount;
        protocolBalance = curProtocolBalance;

        // Transfer tokens
        IToken(olas).transfer(account, amount);

        emit ProtocolBalanceUpdated(curProtocolBalance);

        _locked = 1;
    }
}
