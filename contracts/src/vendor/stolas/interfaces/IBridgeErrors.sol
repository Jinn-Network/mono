// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IBridgeErrors {
    /// @dev Only `manager` has a privilege, but the `sender` was provided.
    /// @param sender Sender address.
    /// @param manager Required sender address as a manager.
    error ManagerOnly(address sender, address manager);

    /// @dev Only `owner` has a privilege, but the `sender` was provided.
    /// @param sender Sender address.
    /// @param owner Required sender address as an owner.
    error OwnerOnly(address sender, address owner);

    /// @dev Provided zero address.
    error ZeroAddress();

    /// @dev Zero value when it has to be different from zero.
    error ZeroValue();

    /// @dev Provided incorrect data length.
    /// @param expected Expected minimum data length.
    /// @param provided Provided data length.
    error IncorrectDataLength(uint256 expected, uint256 provided);

    /// @dev Received lower value than the expected one.
    /// @param provided Provided value is lower.
    /// @param expected Expected value.
    error LowerThan(uint256 provided, uint256 expected);

    /// @dev Value overflow.
    /// @param provided Overflow value.
    /// @param max Maximum possible value.
    error Overflow(uint256 provided, uint256 max);

    /// @dev Target bridge relayer is incorrect.
    /// @param provided Provided relayer address.
    /// @param expected Expected relayer address.
    error TargetRelayerOnly(address provided, address expected);

    /// @dev Message sender from another chain is incorrect.
    /// @param provided Provided message sender address.
    /// @param expected Expected message sender address.
    error WrongMessageSender(address provided, address expected);

    /// @dev Chain Id originating the call is incorrect.
    /// @param provided Provided chain Id.
    /// @param expected Expected chain Id.
    error WrongChainId(uint256 provided, uint256 expected);

    /// @dev Request with specified params is not found in the queue.
    /// @param target Target address.
    /// @param amount Token amount.
    /// @param batchHash Reference batch hash.
    /// @param operation Funds operation: stake / unstake.
    error RequestNotQueued(address target, uint256 amount, bytes32 batchHash, bytes32 operation);

    /// @dev Insufficient token balance.
    /// @param provided Provided balance.
    /// @param expected Expected available amount.
    error InsufficientBalance(uint256 provided, uint256 expected);

    /// @dev Failure of a transfer.
    /// @param token Address of a token.
    /// @param from Address `from`.
    /// @param to Address `to`.
    /// @param amount Token amount.
    error TransferFailed(address token, address from, address to, uint256 amount);

    /// @dev Delivery hash has been already processed.
    /// @param deliveryHash Delivery hash.
    error AlreadyDelivered(bytes32 deliveryHash);

    /// @dev Wrong amount received / provided.
    /// @param provided Provided amount.
    /// @param expected Expected amount.
    error WrongAmount(uint256 provided, uint256 expected);

    /// @dev Provided token address is incorrect.
    /// @param provided Provided token address.
    /// @param expected Expected token address.
    error WrongTokenAddress(address provided, address expected);

    /// @dev The contract is paused.
    error Paused();

    /// @dev The contract is unpaused.
    error Unpaused();

    // @dev Reentrancy guard.
    error ReentrancyGuard();

    /// @dev Account address is incorrect.
    /// @param account Account address.
    error WrongAccount(address account);

    /// @dev Operation not found.
    /// @param batchHash Batch hash.
    /// @param operation Funds operation type.
    error OperationNotFound(bytes32 batchHash, bytes32 operation);

    /// @dev Redeem request failed.
    /// @param batchHash Batch hash.
    /// @param target Staking target address.
    /// @param amount Staking amount.
    /// @param operation Funds operation: stake / unstake.
    /// @param status Request status.
    error RequestFailed(bytes32 batchHash, address target, uint256 amount, bytes32 operation, uint256 status);
}
