// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Implementation, OwnerOnly, ZeroAddress} from "../Implementation.sol";

interface IGovernor {
    /// @dev Create a new proposal to change the protocol / contract parameters.
    /// @param targets The ordered list of target addresses for calls to be made during proposal execution.
    /// @param values The ordered list of values to be passed to the calls made during proposal execution.
    /// @param calldatas The ordered list of data to be passed to each individual function call during proposal execution.
    /// @param description A human readable description of the proposal and the changes it will enact.
    /// @return The Id of the newly created proposal.
    function propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) external returns (uint256);

    /// @dev Casts a vote
    function castVote(uint256 proposalId, uint8 support) external returns (uint256);
}

interface IToken {
    /// @dev Gets the amount of tokens owned by a specified account.
    /// @param account Account address.
    /// @return Amount of tokens owned.
    function balanceOf(address account) external view returns (uint256);

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

interface IVEOLAS {
    /// @dev Deposits `amount` tokens for `msg.sender` and locks for `unlockTime`.
    /// @param amount Amount to deposit.
    /// @param unlockTime Time when tokens unlock, rounded down to a whole week.
    function createLock(uint256 amount, uint256 unlockTime) external;

    /// @dev Deposits `amount` additional tokens for `msg.sender` without modifying the unlock time.
    /// @param amount Amount of tokens to deposit and add to the lock.
    function increaseAmount(uint256 amount) external;

    /// @dev Extends the unlock time.
    /// @param unlockTime New tokens unlock time.
    function increaseUnlockTime(uint256 unlockTime) external;

    /// @dev Withdraws all tokens for `msg.sender`. Only possible if the lock has expired.
    function withdraw() external;
}

/// @dev Zero value.
error ZeroValue();

/// @dev The contract is already initialized.
error AlreadyInitialized();

/// @dev Caught reentrancy violation.
error ReentrancyGuard();

/// @title Lock - Smart contract for veOLAS related lock and voting functions
contract Lock is Implementation {
    event OlasGovernorUpdated(address indexed olasGovernor);
    event LockTimeIncreaseUpdated(uint256 lockTimeIncrease);
    event Withdraw(address indexed to, uint256 amount);

    // Maximum veOLAS lock time (4 years)
    uint256 public constant MAX_LOCK_TIME = 4 * 365 * 1 days;

    // veOLAS address
    address public immutable ve;
    // OLAS address
    address public immutable olas;

    // OLAS olasGovernor address
    address public olasGovernor;
    // OLAS lock time increase value
    uint256 public lockTimeIncrease;

    // Reentrancy lock
    bool transient _locked;

    /// @dev Lock constructor.
    /// @param _olas OLAS address.
    /// @param _ve veOLAS address.
    constructor(address _olas, address _ve) {
        // Check for zero addresses
        if (_olas == address(0) || _ve == address(0)) {
            revert ZeroAddress();
        }

        ve = _ve;
        olas = _olas;
    }

    /// @dev Lock initializer.
    function initialize() external {
        // Check for already initialized
        if (owner != address(0)) {
            revert AlreadyInitialized();
        }

        lockTimeIncrease = MAX_LOCK_TIME;
        owner = msg.sender;
    }

    /// @dev Changes lock time increase value.
    /// @param newLockTimeIncrease New lock time increase value.
    function changeLockTimeIncrease(uint256 newLockTimeIncrease) external {
        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        lockTimeIncrease = newLockTimeIncrease;
        emit LockTimeIncreaseUpdated(newLockTimeIncrease);
    }

    /// @dev Changes OLAS governor address.
    /// @param newOlasGovernor New OLAS governor address.
    function changeGovernor(address newOlasGovernor) external {
        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Check for zero address
        if (newOlasGovernor == address(0)) {
            revert ZeroAddress();
        }

        olasGovernor = newOlasGovernor;
        emit OlasGovernorUpdated(newOlasGovernor);
    }

    /// @dev Sets OLAS governor address and creates first veOLAS lock.
    /// @param _olasGovernor OLAS governor address.
    function setGovernorAndCreateFirstLock(address _olasGovernor) external {
        // Reentrancy guard
        if (_locked) {
            revert ReentrancyGuard();
        }
        _locked = true;

        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Check for zero address
        if (_olasGovernor == address(0)) {
            revert ZeroAddress();
        }

        // Deposit starting OLAS amount
        uint256 olasAmount = IToken(olas).balanceOf(address(this));
        // Check for zero value
        if (olasAmount == 0) {
            revert ZeroValue();
        }

        // Approve OLAS for veOLAS
        IToken(olas).approve(ve, olasAmount);
        // Create lock
        IVEOLAS(ve).createLock(olasAmount, MAX_LOCK_TIME);

        olasGovernor = _olasGovernor;
        emit OlasGovernorUpdated(_olasGovernor);
    }

    /// @dev Increases lock amount and time.
    /// @param olasAmount OLAS amount.
    /// @return unlockTimeIncreased True, if the unlock time has increased.
    function increaseLock(uint256 olasAmount) external returns (bool unlockTimeIncreased) {
        // Reentrancy guard
        if (_locked) {
            revert ReentrancyGuard();
        }
        _locked = true;

        // Get OLAS from sender
        IToken(olas).transferFrom(msg.sender, address(this), olasAmount);

        // Approve OLAS for veOLAS
        IToken(olas).approve(ve, olasAmount);

        // Increase lock amount
        IVEOLAS(ve).increaseAmount(olasAmount);

        uint256 curLockTimeIncrease = lockTimeIncrease;
        if (curLockTimeIncrease > 0) {
            // Increase unlock time to a maximum, if possible
            bytes memory increaseUnlockTimeData = abi.encodeCall(IVEOLAS.increaseUnlockTime, (curLockTimeIncrease));
            // Note: both success and failure are acceptable
            (unlockTimeIncreased,) = ve.call(increaseUnlockTimeData);
        }
    }

    /// @dev Withdraws locked balance.
    /// @param to Address to send funds to.
    function withdraw(address to) external {
        // Reentrancy guard
        if (_locked) {
            revert ReentrancyGuard();
        }
        _locked = true;

        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // veOLAS withdraw
        IVEOLAS(ve).withdraw();

        // Get current balance amount
        uint256 amount = IToken(olas).balanceOf(address(this));

        // Check for non-zero amount
        if (amount > 0) {
            IToken(olas).transfer(to, amount);
        }

        emit Withdraw(to, amount);
    }

    /// @dev Create a new proposal to change the protocol / contract parameters.
    /// @param targets The ordered list of target addresses for calls to be made during proposal execution.
    /// @param values The ordered list of values to be passed to the calls made during proposal execution.
    /// @param calldatas The ordered list of data to be passed to each individual function call during proposal execution.
    /// @param description A human readable description of the proposal and the changes it will enact.
    /// @return The Id of the newly created proposal.
    function propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) external returns (uint256) {
        // Reentrancy guard
        if (_locked) {
            revert ReentrancyGuard();
        }
        _locked = true;

        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        return IGovernor(olasGovernor).propose(targets, values, calldatas, description);
    }

    /// @dev Casts a vote.
    /// @param proposalId Proposal Id.
    /// @param support Support value: against, for, abstain.
    /// @return Vote weight.
    function castVote(uint256 proposalId, uint8 support) external returns (uint256) {
        // Reentrancy guard
        if (_locked) {
            revert ReentrancyGuard();
        }
        _locked = true;

        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        return IGovernor(olasGovernor).castVote(proposalId, support);
    }
}
