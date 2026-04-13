// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IBridgeErrors} from "../../interfaces/IBridgeErrors.sol";

// Collector interface
interface ICollector {
    /// @dev Tops up address(this) with a specified amount as staking proxy unstake reserve.
    /// @param stakingProxy Staking proxy address.
    /// @param amount OLAS amount.
    function topUpUnstakeReserve(address stakingProxy, uint256 amount) external;
}

// StakingManager interface
interface IStakingManager {
    /// @dev Stakes OLAS into specified staking proxy contract if deposit + balance is enough for staking.
    /// @param stakingProxy Staking proxy address.
    /// @param amount OLAS amount.
    /// @param operation Stake operation type.
    function stake(address stakingProxy, uint256 amount, bytes32 operation) external;

    /// @dev Unstakes, if needed, and withdraws specified amounts from a specified staking contract.
    /// @notice Unstakes services if needed to satisfy withdraw requests.
    ///         Call this to unstake definitely terminated staking contracts - deactivated on L1 and / or ran out of funds.
    ///         The majority of discovered chains does not need any value to process token bridge transfer.
    /// @param stakingProxy Staking proxy address.
    /// @param amount Unstake amount.
    /// @param operation Unstake operation type.
    function unstake(address stakingProxy, uint256 amount, bytes32 operation) external;
}

interface IExternalStakingDistributor {
    /// @dev Deposits OLAS for further staking.
    /// @param amount OLAS amount.
    /// @param operation Stake operation type.
    function deposit(uint256 amount, bytes32 operation) external;

    /// @dev Requests withdraw via specified unstake operation, and request to add to unstake amount, if required.
    /// @param amount Specified unstake amount.
    /// @param operation Unstake operation type.
    function withdrawAndRequestUnstake(uint256 amount, bytes32 operation) external;
}

// Necessary ERC20 token interface
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

    /// @dev Gets the amount of tokens owned by a specified account.
    /// @param account Account address.
    /// @return Amount of tokens owned.
    function balanceOf(address account) external view returns (uint256);
}

/// @title DefaultStakingProcessorL2 - Smart contract for processing tokens and data received on L2, and tokens sent back to L1.
abstract contract DefaultStakingProcessorL2 is IBridgeErrors {
    enum RequestStatus {
        NON_EXISTENT,
        EXTERNAL_CALL_FAILED,
        INSUFFICIENT_OLAS_BALANCE,
        UNSUPPORTED_OPERATION_TYPE,
        CONTRACT_PAUSED
    }

    event OwnerUpdated(address indexed owner);
    event FundsReceived(address indexed sender, uint256 value);
    event RequestExecuted(bytes32 indexed batchHash, address target, uint256 amount, bytes32 operation);
    event RequestQueued(
        bytes32 indexed batchHash, address indexed target, uint256 amount, bytes32 operation, RequestStatus status
    );
    event MessageReceived(address indexed sender, uint256 chainId, bytes data);
    event Drain(address indexed owner, uint256 amount);
    event StakingProcessorPaused();
    event StakingProcessorUnpaused();

    // Maximum chain Id as per EVM specs
    uint256 public constant MAX_CHAIN_ID = type(uint64).max / 2 - 36;
    // Stake operation
    bytes32 public constant STAKE = 0x1bcc0f4c3fad314e585165815f94ecca9b96690a26d6417d7876448a9a867a69;
    // Unstake operation
    bytes32 public constant UNSTAKE = 0x8ca9a95e41b5eece253c93f5b31eed1253aed6b145d8a6e14d913fdf8e732293;
    // Unstake-retired operation
    bytes32 public constant UNSTAKE_RETIRED = 0x9065ad15d9673159e4597c86084aff8052550cec93c5a6e44b3f1dba4c8731b3;

    // OLAS address
    address public immutable olas;
    // Staking manager address
    address public immutable stakingManager;
    // External staking distributor address
    address public immutable externalStakingDistributor;
    // Collector address
    address public immutable collector;
    // L2 Relayer address that receives the message across the bridge from the source L1 network
    address public immutable l2MessageRelayer;
    // L2 Token relayer address that sends tokens to the L1 source network
    address public immutable l2TokenRelayer;
    // Deposit processor address on L1 that is authorized to propagate the transaction execution across the bridge
    address public immutable l1DepositProcessor;
    // Deposit processor chain Id
    uint256 public immutable l1SourceChainId;
    // Owner address (Timelock or bridge mediator)
    address public owner;
    // Pause switcher
    uint256 public paused;
    // Reentrancy lock
    uint256 internal _locked;

    // Processed batch hashes
    mapping(bytes32 => bool) public processedHashes;
    // Queued hashes of (batchHash, target, amount, operation): true if request is queued
    mapping(bytes32 => RequestStatus) public queuedHashes;

    /// @dev DefaultStakerL2 constructor.
    /// @param _olas OLAS token address on L2.
    /// @param _stakingManager StakingManager address.
    /// @param _externalStakingDistributor ExternalStakingDistributor address.
    /// @param _collector Collector address.
    /// @param _l2TokenRelayer L2 token relayer bridging contract address.
    /// @param _l2MessageRelayer L2 message relayer bridging contract address.
    /// @param _l1SourceChainId L1 source chain Id.
    constructor(
        address _olas,
        address _stakingManager,
        address _externalStakingDistributor,
        address _collector,
        address _l2TokenRelayer,
        address _l2MessageRelayer,
        address _l1DepositProcessor,
        uint256 _l1SourceChainId
    ) {
        // Check for zero addresses
        if (
            _olas == address(0) || _stakingManager == address(0) || _externalStakingDistributor == address(0)
                || _collector == address(0) || _l2TokenRelayer == address(0) || _l2MessageRelayer == address(0)
                || _l1DepositProcessor == address(0)
        ) {
            revert ZeroAddress();
        }

        // Check for a zero value
        if (_l1SourceChainId == 0) {
            revert ZeroValue();
        }

        // Check for overflow value
        if (_l1SourceChainId > MAX_CHAIN_ID) {
            revert Overflow(_l1SourceChainId, MAX_CHAIN_ID);
        }

        // Immutable parameters assignment
        olas = _olas;
        stakingManager = _stakingManager;
        externalStakingDistributor = _externalStakingDistributor;
        collector = _collector;
        l2TokenRelayer = _l2TokenRelayer;
        l2MessageRelayer = _l2MessageRelayer;
        l1DepositProcessor = _l1DepositProcessor;
        l1SourceChainId = _l1SourceChainId;

        // State variables assignment
        owner = msg.sender;
        paused = 1;
        _locked = 1;
    }

    /// @dev Processes the data received from L1.
    /// @param data Bytes message data sent from L1.
    function _processData(bytes memory data) internal {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Decode received data
        (address target, uint256 amount, bytes32 batchHash, bytes32 operation) =
            abi.decode(data, (address, uint256, bytes32, bytes32));

        // Check that the batch hash has not yet being processed
        // Possible scenario: bridge failed to deliver from L1 to L2, maintenance function is called by the DAO,
        // and the bridge somehow re-delivers the same message that has already been processed
        if (processedHashes[batchHash]) {
            revert AlreadyDelivered(batchHash);
        }
        processedHashes[batchHash] = true;

        bool success;

        // Status to be emitted for failing scenarios, since reverts cannot be engaged in this function call
        // By default, status is set to external call failed, and changed to another failed one, if not succeeded
        RequestStatus status = RequestStatus.EXTERNAL_CALL_FAILED;
        if (operation == STAKE) {
            if (paused == 1) {
                // Get current OLAS balance
                uint256 olasBalance = IToken(olas).balanceOf(address(this));

                // Check the OLAS balance and the contract being unpaused
                if (olasBalance >= amount) {
                    if (target == externalStakingDistributor) {
                        // Approve OLAS for externalStakingDistributor
                        IToken(olas).approve(externalStakingDistributor, amount);

                        // This is a low level call since it must never revert
                        bytes memory stakeData =
                            abi.encodeCall(IExternalStakingDistributor.deposit, (amount, operation));
                        (success,) = externalStakingDistributor.call(stakeData);
                    } else {
                        // Approve OLAS for stakingManager
                        IToken(olas).approve(stakingManager, amount);

                        // This is a low level call since it must never revert
                        bytes memory stakeData = abi.encodeCall(IStakingManager.stake, (target, amount, operation));
                        (success,) = stakingManager.call(stakeData);
                    }
                } else {
                    // Insufficient OLAS balance
                    status = RequestStatus.INSUFFICIENT_OLAS_BALANCE;
                }
            } else {
                // Contract is paused
                status = RequestStatus.CONTRACT_PAUSED;
            }
        } else if (operation == UNSTAKE || operation == UNSTAKE_RETIRED) {
            // Note that if UNSTAKE* is requested, it must be finalized in any case since changes are recorded on L1
            // These are low level calls since they must never revert
            if (target == externalStakingDistributor) {
                bytes memory unstakeData =
                    abi.encodeCall(IExternalStakingDistributor.withdrawAndRequestUnstake, (amount, operation));
                (success,) = externalStakingDistributor.call(unstakeData);
            } else {
                bytes memory unstakeData = abi.encodeCall(IStakingManager.unstake, (target, amount, operation));
                (success,) = stakingManager.call(unstakeData);
            }
        } else {
            // Unsupported operation type
            status = RequestStatus.UNSUPPORTED_OPERATION_TYPE;
        }

        // Check for operation success and queue, if required
        if (success) {
            emit RequestExecuted(batchHash, target, amount, operation);
        } else {
            // Hash of batchHash + target + amount + operation + current target dispenser address
            bytes32 queueHash = getQueuedHash(batchHash, target, amount, operation);
            // Queue the hash for further redeem
            queuedHashes[queueHash] = status;

            emit RequestQueued(batchHash, target, amount, operation, status);
        }

        _locked = 1;
    }

    /// @dev Receives a message from L1.
    /// @param messageRelayer L2 bridge message relayer address.
    /// @param sourceProcessor L1 deposit processor address.
    /// @param data Bytes message data sent from L1.
    function _receiveMessage(address messageRelayer, address sourceProcessor, bytes memory data) internal virtual {
        // Check L2 message relayer address
        if (messageRelayer != l2MessageRelayer) {
            revert TargetRelayerOnly(messageRelayer, l2MessageRelayer);
        }

        // Check L1 deposit processor address
        if (sourceProcessor != l1DepositProcessor) {
            revert WrongMessageSender(sourceProcessor, l1DepositProcessor);
        }

        emit MessageReceived(l1DepositProcessor, l1SourceChainId, data);

        // Process the data
        _processData(data);
    }

    /// @dev Changes the owner address.
    /// @param newOwner Address of a new owner.
    function changeOwner(address newOwner) external {
        // Check for the contract ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Check for the zero address
        if (newOwner == address(0)) {
            revert ZeroAddress();
        }

        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    /// @dev Redeems queued staking deposit / withdraw.
    /// @param batchHash Batch hash.
    /// @param target Staking target address.
    /// @param amount Staking amount.
    /// @param operation Funds operation: stake / unstake.
    function redeem(bytes32 batchHash, address target, uint256 amount, bytes32 operation) external {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Pause check
        if (paused == 2) {
            revert Paused();
        }

        // Hash of batchHash + target + amount + operation + chainId + current target dispenser address
        bytes32 queueHash = getQueuedHash(batchHash, target, amount, operation);
        RequestStatus requestStatus = queuedHashes[queueHash];
        // Check if the target and amount are queued
        if (requestStatus == RequestStatus.NON_EXISTENT) {
            revert RequestNotQueued(target, amount, batchHash, operation);
        }

        // Check for operation type
        // STAKE operation always involves amounts, thus either stake() needs to be finalized, or funds are returned to L1
        // Note that if contract is paused when STAKE operation is requested, funds are safely returned to L1, since
        // contract might be paused for good
        // However, if UNSTAKE* is requested, it must be finalized in any case since changes are recorded on L1
        if (operation == STAKE) {
            // Get the current contract OLAS balance
            uint256 olasBalance = IToken(olas).balanceOf(address(this));
            if (olasBalance >= amount) {
                if (target == externalStakingDistributor) {
                    // Approve OLAS for externalStakingDistributor
                    IToken(olas).approve(externalStakingDistributor, amount);
                } else {
                    // Approve OLAS for stakingManager
                    IToken(olas).approve(stakingManager, amount);
                }
            } else {
                // OLAS balance is not enough for redeem
                revert InsufficientBalance(olasBalance, amount);
            }

            // If request was queued due to insufficient balance - continue with the stake
            if (requestStatus == RequestStatus.INSUFFICIENT_OLAS_BALANCE) {
                if (target == externalStakingDistributor) {
                    IExternalStakingDistributor(externalStakingDistributor).deposit(amount, operation);
                } else {
                    IStakingManager(stakingManager).stake(target, amount, operation);
                }
            } else {
                // Approve OLAS for collector to initiate L1 transfer for corresponding operation by agents
                IToken(olas).approve(collector, amount);

                // Request top-up by Collector for staking proxy unstake reserve
                ICollector(collector).topUpUnstakeReserve(target, amount);
            }
        } else if (operation == UNSTAKE || operation == UNSTAKE_RETIRED) {
            // UNSTAKE* must be finalized
            if (target == externalStakingDistributor) {
                IExternalStakingDistributor(externalStakingDistributor).withdrawAndRequestUnstake(amount, operation);
            } else {
                IStakingManager(stakingManager).unstake(target, amount, operation);
            }
        } else {
            revert RequestFailed(batchHash, target, amount, operation, uint256(requestStatus));
        }

        // Remove processed queued nonce
        queuedHashes[queueHash] = RequestStatus.NON_EXISTENT;

        emit RequestExecuted(batchHash, target, amount, operation);

        _locked = 1;
    }

    /// @dev Pause the contract.
    function pause() external {
        // Check for the contract ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        paused = 2;
        emit StakingProcessorPaused();
    }

    /// @dev Unpause the contract
    function unpause() external {
        // Check for the contract ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        paused = 1;
        emit StakingProcessorUnpaused();
    }

    /// @dev Drains contract native funds.
    /// @notice For cross-bridge leftovers and incorrectly sent funds.
    /// @return nativeAmount Drained native amount.
    function drain() external returns (uint256 nativeAmount) {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        // Check for the owner address
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Drain leftover funds
        nativeAmount = address(this).balance;

        // Check for zero value
        if (nativeAmount == 0) {
            revert ZeroValue();
        }

        // Send funds to owner
        (bool success,) = msg.sender.call{value: nativeAmount}("");
        if (!success) {
            revert TransferFailed(address(0), address(this), msg.sender, nativeAmount);
        }

        emit Drain(msg.sender, nativeAmount);

        _locked = 1;
    }

    /// @dev Relays OLAS to L1.
    /// @param to Address to send tokens to.
    /// @param olasAmount OLAS amount.
    /// @param bridgePayload Bridge payload.
    function relayToL1(address to, uint256 olasAmount, bytes memory bridgePayload) external payable virtual;

    /// @dev Gets failed request queued hash.
    /// @param batchHash Batch hash.
    /// @param target Staking target address.
    /// @param amount Staking amount.
    /// @param operation Funds operation: stake / unstake.
    function getQueuedHash(bytes32 batchHash, address target, uint256 amount, bytes32 operation)
        public
        view
        returns (bytes32)
    {
        // Hash of batchHash + target + amount + operation + current target dispenser address
        return keccak256(abi.encode(batchHash, target, amount, operation, block.chainid, address(this)));
    }

    /// @dev Gets the maximum number of token decimals able to be transferred across the bridge.
    /// @return Number of supported decimals.
    function getBridgingDecimals() public pure virtual returns (uint256) {
        return 18;
    }

    /// @dev Receives native network token.
    receive() external payable {
        emit FundsReceived(msg.sender, msg.value);
    }
}
