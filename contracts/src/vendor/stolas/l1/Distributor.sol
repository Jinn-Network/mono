// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Implementation, OwnerOnly} from "../Implementation.sol";
import {IToken} from "../interfaces/IToken.sol";

interface ILock {
    /// @dev Increases lock amount and time.
    /// @param olasAmount OLAS amount.
    /// @return True, if the unlock time has increased.
    function increaseLock(uint256 olasAmount) external returns (bool);
}

interface IST {
    /// @dev Top-ups vault balance via Distributor.
    /// @param amount OLAS amount.
    function topUpVaultBalance(uint256 amount) external;
}

/// @dev Zero value.
error ZeroValue();

/// @dev The contract is already initialized.
error AlreadyInitialized();

/// @dev Unauthorized account.
/// @param account Account address.
error UnauthorizedAccount(address account);

/// @dev Caught reentrancy violation.
error ReentrancyGuard();

/// @title Distributor - Smart contract for distributing funds obtained via bridging or direct deposits.
contract Distributor is Implementation {
    event LockFactorUpdated(uint256 lockFactor);
    event Locked(address indexed account, uint256 olasAmount, uint256 lockAmount, uint256 vaultBalance);
    event Distributed(address indexed account, address indexed st, uint256 olasAmount);

    // Depository version
    string public constant VERSION = "0.1.0";
    // Max lock factor
    uint256 public constant MAX_LOCK_FACTOR = 10_000;

    // OLAS contract address
    address public immutable olas;
    // stOLAS contract address
    address public immutable st;
    // Lock contract address
    address public immutable lock;

    // Lock factor in 10_000 value
    uint256 public lockFactor;

    // Reentrancy lock
    bool transient _locked;

    /// @dev Distributor constructor.
    /// @param _olas OLAS address.
    /// @param _st stOLAS address.
    /// @param _lock Lock address.
    constructor(address _olas, address _st, address _lock) {
        olas = _olas;
        st = _st;
        lock = _lock;
    }

    /// @dev Increases veOLAS lock.
    /// @param olasAmount OLAS amount to get lock part from.
    /// @return remainder veOLAS locked amount.
    function _increaseLock(uint256 olasAmount) internal returns (uint256 remainder) {
        // Get treasury veOLAS lock amount
        uint256 lockAmount = (olasAmount * lockFactor) / MAX_LOCK_FACTOR;

        // Approve OLAS for Lock
        IToken(olas).approve(lock, lockAmount);

        // Form increase lock payload
        bytes memory lockPayload = abi.encodeCall(ILock.increaseLock, (lockAmount));
        // Increase lock
        (bool success,) = lock.call(lockPayload);

        // Check for successful increase lock call
        if (success) {
            // lock amount is locked
            remainder = olasAmount - lockAmount;

            emit Locked(msg.sender, olasAmount, lockAmount, remainder);
        } else {
            // lock amount is not locked, letting all olas amount be transferred to stOLAS
            remainder = olasAmount;
        }
    }

    /// @dev Distributor initializer.
    /// @param _lockFactor Lock factor value.
    function initialize(uint256 _lockFactor) external {
        // Check for already initialized
        if (owner != address(0)) {
            revert AlreadyInitialized();
        }

        lockFactor = _lockFactor;

        owner = msg.sender;
    }

    /// @dev Changes lock factor value.
    /// @param newLockFactor New lock factor value.
    function changeLockFactor(uint256 newLockFactor) external {
        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Check for zero value
        if (newLockFactor == 0) {
            revert ZeroValue();
        }

        lockFactor = newLockFactor;
        emit LockFactorUpdated(newLockFactor);
    }

    /// @dev Distributes OLAS to stOLAS for balances re-distribution.
    function distribute() external {
        // Reentrancy guard
        if (_locked) {
            revert ReentrancyGuard();
        }
        _locked = true;

        // Get OLAS balance
        uint256 olasAmount = IToken(olas).balanceOf(address(this));

        if (olasAmount > 0) {
            // Lock OLAS for veOLAS
            olasAmount = _increaseLock(olasAmount);

            // Approve OLAS for stOLAS
            IToken(olas).approve(st, olasAmount);

            // Top-up stOLAS with the approved amount
            IST(st).topUpVaultBalance(olasAmount);

            emit Distributed(msg.sender, st, olasAmount);
        }
    }
}
