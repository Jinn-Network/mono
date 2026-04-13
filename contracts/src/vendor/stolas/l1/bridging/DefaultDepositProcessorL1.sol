// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IBridgeErrors} from "../../interfaces/IBridgeErrors.sol";

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

/// @title DefaultDepositProcessorL1 - Smart contract for sending tokens and data via arbitrary bridge from L1 to L2 and processing data received from L2.
abstract contract DefaultDepositProcessorL1 is IBridgeErrors {
    event MessagePosted(uint256 indexed sequence, address indexed target, uint256 amount, bytes32 indexed batchHash);
    event L2StakerUpdated(address indexed l2StakingProcessor);
    event LeftoversRefunded(address indexed sender, uint256 leftovers, bool success);
    event Drained(address indexed sender, address indexed receiver, uint256 amount);

    // Stake operation
    bytes32 public constant STAKE = 0x1bcc0f4c3fad314e585165815f94ecca9b96690a26d6417d7876448a9a867a69;
    // receiveMessage selector to be executed on L2
    bytes4 public constant RECEIVE_MESSAGE = bytes4(keccak256(bytes("receiveMessage(bytes)")));
    // Token transfer gas limit for L2
    // This is safe as the value is practically bigger than observed ones on numerous chains
    uint256 public constant TOKEN_GAS_LIMIT = 300_000;
    // Message transfer gas limit for L2
    uint256 public constant MESSAGE_GAS_LIMIT = 2_000_000;
    // OLAS token address
    address public immutable olas;
    // L1 depository address
    address public immutable l1Depository;
    // L1 token relayer bridging contract address
    address public immutable l1TokenRelayer;
    // L1 message relayer bridging contract address
    address public immutable l1MessageRelayer;
    // L2 staker address, set by the deploying owner
    address public l2StakingProcessor;
    // Contract owner until the time when the l2StakingProcessor is set
    address public owner;
    // Nonce for each message batch
    uint256 public messageBatchNonce;

    /// @dev DefaultDepositProcessorL1 constructor.
    /// @param _olas OLAS token address on L1.
    /// @param _l1Depository L1 depository address.
    /// @param _l1TokenRelayer L1 token relayer bridging contract address.
    /// @param _l1MessageRelayer L1 message relayer bridging contract address.
    constructor(address _olas, address _l1Depository, address _l1TokenRelayer, address _l1MessageRelayer) {
        // Check for zero addresses
        if (_l1Depository == address(0) || _l1TokenRelayer == address(0) || _l1MessageRelayer == address(0)) {
            revert ZeroAddress();
        }

        olas = _olas;
        l1Depository = _l1Depository;
        l1TokenRelayer = _l1TokenRelayer;
        l1MessageRelayer = _l1MessageRelayer;
        owner = msg.sender;
    }

    /// @dev Sends message to the L2 side via a corresponding bridge.
    /// @notice Message is sent to the staker contract to reflect transferred OLAS and staking amounts.
    /// @param target Staking target address.
    /// @param amount Corresponding staking amount.
    /// @param bridgePayload Bridge payload necessary (if required) for a specific bridging relayer.
    /// @param batchHash Unique batch hash for each message transfer.
    /// @param operation Funds operation: stake / unstake.
    /// @return sequence Unique message sequence (if applicable) or the batch hash converted to number.
    /// @return leftovers ETH leftovers from unused msg.value.
    function _sendMessage(
        address target,
        uint256 amount,
        bytes memory bridgePayload,
        bytes32 batchHash,
        bytes32 operation
    ) internal virtual returns (uint256 sequence, uint256 leftovers);

    /// @dev Sends a message to the L2 side via a corresponding bridge.
    /// @param target Staking target addresses.
    /// @param amount Corresponding staking amount.
    /// @param bridgePayload Bridge payload necessary (if required) for a specific bridge relayer.
    /// @param operation Funds operation: stake / unstake.
    /// @param sender Sender account.
    function sendMessage(address target, uint256 amount, bytes memory bridgePayload, bytes32 operation, address sender)
        external
        payable
        virtual
    {
        // Check for the dispenser contract to be the msg.sender
        if (msg.sender != l1Depository) {
            revert ManagerOnly(l1Depository, msg.sender);
        }

        // Check for zero value
        if (operation == STAKE && amount == 0) {
            revert ZeroValue();
        }

        // Get the batch hash
        uint256 batchNonce = messageBatchNonce;
        bytes32 batchHash = keccak256(abi.encode(batchNonce, address(this), block.timestamp, block.chainid));

        // Send the message to L2
        (uint256 sequence, uint256 leftovers) = _sendMessage(target, amount, bridgePayload, batchHash, operation);

        // Send leftover amount back to the sender, if any
        if (leftovers > 0) {
            // If the call fails, ignore to avoid the attack that would prevent this function from executing
            // solhint-disable-next-line avoid-low-level-calls
            (bool success,) = sender.call{value: leftovers}("");

            emit LeftoversRefunded(sender, leftovers, success);
        }

        // Increase the staking batch nonce
        messageBatchNonce = batchNonce + 1;

        emit MessagePosted(sequence, target, amount, batchHash);
    }

    /// @dev Sets L2 staking processor address and zero-s the owner.
    /// @param l2Processor L2 staking processor address.
    function _setL2StakingProcessor(address l2Processor) internal {
        // Check the contract ownership
        if (msg.sender != owner) {
            revert OwnerOnly(owner, msg.sender);
        }

        // The L2 staker must have a non zero address
        if (l2Processor == address(0)) {
            revert ZeroAddress();
        }
        l2StakingProcessor = l2Processor;

        // Revoke the owner role making the contract ownerless
        owner = address(0);

        emit L2StakerUpdated(l2Processor);
    }

    /// @dev Sets L2 staking processor address.
    /// @param l2Processor L2 staking processor address.
    function setL2StakingProcessor(address l2Processor) external virtual {
        _setL2StakingProcessor(l2Processor);
    }

    /// @dev Drains possible stuck values.
    function drain() external {
        // Get owner address: it cannot be zero because the proxy is already initialized
        address localOwner = owner;

        // Get contract value balance
        uint256 amount = address(this).balance;

        // Check for zero value
        if (amount == 0) {
            revert ZeroValue();
        }

        // solhint-disable-next-line avoid-low-level-calls
        (bool success,) = localOwner.call{value: amount}("");

        if (!success) {
            revert TransferFailed(address(0), address(this) , localOwner, amount);
        }

        emit Drained(msg.sender, localOwner, amount);
    }

    /// @dev Gets the maximum number of token decimals able to be transferred across the bridge.
    /// @return Number of supported decimals.
    function getBridgingDecimals() external pure virtual returns (uint256) {
        return 18;
    }
}
