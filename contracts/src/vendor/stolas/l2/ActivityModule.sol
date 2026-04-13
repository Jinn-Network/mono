// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface ICollector {
    function topUpBalance(uint256 amount, bytes32 operation) external;
}

/// @dev Safe multi send interface
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

interface ISafe {
    enum Operation {
        Call,
        DelegateCall
    }

    function nonce() external returns (uint256);

    /// @dev Marks a hash as approved. This can be used to validate a hash that is used by a signature.
    /// @param hashToApprove The hash that should be marked as approved for signatures that are verified by this contract.
    function approveHash(bytes32 hashToApprove) external;

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

    /// @dev Returns hash to be signed by owners.
    /// @param to Destination address.
    /// @param value Ether value.
    /// @param data Data payload.
    /// @param operation Operation type.
    /// @param safeTxGas Fas that should be used for the safe transaction.
    /// @param baseGas Gas costs for data used to trigger the safe transaction.
    /// @param gasPrice Maximum gas price that should be used for this transaction.
    /// @param gasToken Token address (or 0 if ETH) that is used for the payment.
    /// @param refundReceiver Address of receiver of gas payment (or 0 if tx.origin).
    /// @param _nonce Transaction nonce.
    /// @return Transaction hash.
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _nonce
    ) external view returns (bytes32);

    /// @dev Allows a Module to execute a Safe transaction without any further confirmations.
    /// @param to Destination address of module transaction.
    /// @param value Ether value of module transaction.
    /// @param data Data payload of module transaction.
    /// @param operation Operation type of module transaction.
    function execTransactionFromModule(address to, uint256 value, bytes memory data, Operation operation)
        external
        returns (bool success);
}

interface IStakingManager {
    /// @dev Claims specified service rewards.
    /// @param stakingProxy Staking proxy address.
    /// @param serviceId Service Id.
    /// @return Staking reward.
    function claim(address stakingProxy, uint256 serviceId) external returns (uint256);
}

// ERC20 token interface
interface IToken {
    /// @dev Sets `amount` as the allowance of `spender` over the caller's tokens.
    /// @param spender Account address that will be able to transfer tokens on behalf of the caller.
    /// @param amount Token amount.
    /// @return True if the function execution is successful.
    function approve(address spender, uint256 amount) external returns (bool);

    /// @dev Gets the amount of tokens owned by a specified account.
    /// @param account Account address.
    /// @return Amount of tokens owned.
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Zero address.
error ZeroAddress();

/// @dev Zero value.
error ZeroValue();

/// @dev The contract is already initialized.
error AlreadyInitialized();

/// @dev Caught reentrancy violation.
error ReentrancyGuard();

/// @dev Only `manager` has a privilege, but the `sender` was provided.
/// @param sender Sender address.
/// @param manager Required sender address as a manager.
error ManagerOnly(address sender, address manager);

/// @dev Execution has failed.
/// @param target Target address.
/// @param payload Payload data.
error ExecutionFailed(address target, bytes payload);

/// @title ActivityModule - Smart contract for multisig activity tracking
contract ActivityModule {
    event ActivityIncreased(uint256 activityChange);
    event Drained(uint256 balance);

    // Activity Module version
    string public constant VERSION = "0.1.0";

    // Reward transfer operation
    bytes32 public constant REWARD = 0x0b9821ae606ebc7c79bf3390bdd3dc93e1b4a7cda27aad60646e7b88ff55b001;
    // Default activity increment
    uint256 public constant DEFAULT_ACTIVITY = 1;

    // OLAS token address
    address public immutable olas;
    // Rewards collector address
    address public immutable collector;
    // Multisend contract address
    address public immutable multiSend;

    // Activity tracker
    uint256 public activityNonce;
    // Service Id
    uint256 public serviceId;
    // Multisig address
    address public multisig;
    // Staking proxy address
    address public stakingProxy;
    // Staking manager address
    address public stakingManager;

    // Reentrancy lock
    uint256 internal _locked;

    /// @dev ActivityModule constructor.
    /// @param _olas OLAS address.
    /// @param _collector Collector address.
    /// @param _multiSend Multisend contract address.
    constructor(address _olas, address _collector, address _multiSend) {
        olas = _olas;
        collector = _collector;
        multiSend = _multiSend;
    }

    /// @dev Drains unclaimed rewards after service unstake.
    /// @return balance Amount drained.
    function _drain() internal returns (uint256 balance) {
        // Get multisig balance
        balance = IToken(olas).balanceOf(multisig);

        // Check for zero balance
        if (balance > 0) {
            // Encode OLAS approve function call
            bytes memory data = abi.encodeCall(IToken.approve, (collector, balance));
            // MultiSend payload with the packed data of (operation, multisig address, value(0), payload length, payload)
            bytes memory msPayload = abi.encodePacked(ISafe.Operation.Call, olas, uint256(0), data.length, data);

            // Encode collector top-up function call
            data = abi.encodeCall(ICollector.topUpBalance, (balance, REWARD));
            // Concatenate multi send payload with the packed data of (operation, multisig address, value(0), payload length, payload)
            msPayload = bytes.concat(
                msPayload, abi.encodePacked(ISafe.Operation.Call, collector, uint256(0), data.length, data)
            );

            // Multisend call to execute all the payloads
            msPayload = abi.encodeCall(IMultiSend.multiSend, (msPayload));

            // Execute module call
            bool success =
                ISafe(multisig).execTransactionFromModule(multiSend, 0, msPayload, ISafe.Operation.DelegateCall);

            // Check for success
            if (!success) {
                revert ExecutionFailed(multiSend, msPayload);
            }

            emit Drained(balance);
        }
    }

    /// @dev Increases module activity.
    /// @param activityChange Activity change value.
    function _increaseActivity(uint256 activityChange) internal {
        activityNonce += activityChange;

        emit ActivityIncreased(activityChange);
    }

    /// @dev Initializes activity module proxy.
    /// @param _multisig Service multisig address.
    /// @param _stakingProxy Staking proxy address.
    /// @param _serviceId Service Id.
    function initialize(address _multisig, address _stakingProxy, uint256 _serviceId) external {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        if (multisig != address(0)) {
            revert AlreadyInitialized();
        }

        // Check for zero address
        if (_multisig == address(0) || _stakingProxy == address(0)) {
            revert ZeroAddress();
        }

        // Check for zero value
        if (_serviceId == 0) {
            revert ZeroValue();
        }

        multisig = _multisig;
        stakingProxy = _stakingProxy;
        stakingManager = msg.sender;
        serviceId = _serviceId;

        // Set up address(this) as multisig module
        // Get signature for approved hash case
        bytes32 r = bytes32(uint256(uint160(address(this))));
        bytes memory signature = abi.encodePacked(r, bytes32(0), uint8(1));

        // Encode enable module function call
        bytes memory data = abi.encodeCall(ISafe.enableModule, (address(this)));

        // Get multisig nonce
        uint256 nonce = ISafe(multisig).nonce();
        // Check for zero value, as only newly created multisig is considered valid
        if (nonce > 0) {
            revert AlreadyInitialized();
        }

        bytes32 txHash = ISafe(multisig).getTransactionHash(
            multisig, 0, data, ISafe.Operation.Call, 0, 0, 0, address(0), address(0), nonce
        );

        // Approve hash
        ISafe(multisig).approveHash(txHash);

        // Execute multisig transaction
        ISafe(multisig).execTransaction(
            multisig, 0, data, ISafe.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature
        );

        _locked = 1;
    }

    /// @dev Increases initial module activity.
    function increaseInitialActivity() external {
        if (msg.sender != stakingManager) {
            revert ManagerOnly(msg.sender, stakingManager);
        }

        _increaseActivity(DEFAULT_ACTIVITY);
    }

    /// @dev Claims corresponding service rewards.
    /// @return claimed Amount claimed.
    function claim() external returns (uint256 claimed) {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Claim staking reward
        IStakingManager(stakingManager).claim(stakingProxy, serviceId);

        // Drain claimed funds
        claimed = _drain();
        // Check for successful claim, otherwise the activity does not count
        if (claimed > 0) {
            // Increase activity for the next staking epoch
            _increaseActivity(DEFAULT_ACTIVITY);
        }

        _locked = 1;
    }

    /// @dev Drains multisig failed or unclaimed rewards.
    /// @return balance Amount drained.
    function drain() external returns (uint256 balance) {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        if (msg.sender != stakingManager) {
            revert ManagerOnly(msg.sender, stakingManager);
        }

        // Drain funds
        balance = _drain();

        _locked = 1;
    }
}
