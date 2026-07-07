// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @dev Minimal ERC20 surface needed by the faucet.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Provided zero address.
error ZeroAddress();

/// @dev Zero value when it has to be different from zero.
error ZeroValue();

/// @dev Only owner can call this function.
error OwnerOnly(address sender, address owner);

/// @dev Recipient drip is still within the rate-limit window.
error TooSoon(address recipient, uint256 nextAvailableAt);

/// @dev Faucet balance is below the drip amount — refill required.
error FaucetEmpty(uint256 requested, uint256 available);

/// @dev ERC20 transfer returned false.
error TransferFailed();

/// @title JinnTestnetFaucet - Testnet JINN admin stash with optional per-recipient drip
/// @author JIN Network
/// @notice Deployed on Base Sepolia. Pre-funded by the Jinn team bridging JINN
///         from Sepolia L1. NOT wired into `jinn bootstrap` — operator onboarding
///         does not require JINN on the master EOA (stOLAS standard mode stakes
///         out of the distributor's pool, not the caller's balance; see
///         `ExternalStakingDistributor.stake`). This contract exists as a
///         testnet admin stash: the Jinn team withdraws JINN from here into the
///         distributor or hands it out via `drip(recipient)` when a future
///         user-facing flow (e.g. testnet staker UX) needs it.
contract JinnTestnetFaucet {
    /// @dev L2 JINN token being dispensed.
    IERC20 public immutable jinn;

    /// @dev Contract owner — tunes parameters, withdraws balance, transfers ownership.
    address public owner;

    /// @dev Amount transferred per successful drip (in wei; JINN has 18 decimals).
    uint256 public dripAmount;

    /// @dev Minimum seconds between drips per recipient.
    uint256 public dripInterval;

    /// @dev Timestamp of the last successful drip per recipient.
    mapping(address => uint256) public lastDripAt;

    event Dripped(address indexed recipient, uint256 amount, uint256 nextEligibleAt);
    event DripAmountUpdated(uint256 oldAmount, uint256 newAmount);
    event DripIntervalUpdated(uint256 oldInterval, uint256 newInterval);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Withdrawn(address indexed to, uint256 amount);

    constructor(IERC20 _jinn, uint256 _dripAmount, uint256 _dripInterval) {
        if (address(_jinn) == address(0)) revert ZeroAddress();
        if (_dripAmount == 0) revert ZeroValue();
        if (_dripInterval == 0) revert ZeroValue();
        jinn = _jinn;
        dripAmount = _dripAmount;
        dripInterval = _dripInterval;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ============ Drip ============

    /// @notice Dispense `dripAmount` JINN to `recipient`, subject to per-recipient rate limit.
    /// @dev Anyone can pay gas. Rate limit is keyed on `recipient`, so griefing via
    ///      spam-calling on behalf of an operator does not drain the faucet faster than
    ///      the operator could themselves. Reverts `FaucetEmpty` if the contract's JINN
    ///      balance is below `dripAmount`, allowing the caller to surface a helpful refill prompt.
    /// @param recipient Address to receive the drip.
    function drip(address recipient) external {
        if (recipient == address(0)) revert ZeroAddress();

        uint256 nextAvailable = lastDripAt[recipient] + dripInterval;
        if (block.timestamp < nextAvailable) {
            revert TooSoon(recipient, nextAvailable);
        }

        uint256 available = jinn.balanceOf(address(this));
        if (available < dripAmount) {
            revert FaucetEmpty(dripAmount, available);
        }

        lastDripAt[recipient] = block.timestamp;

        bool ok = jinn.transfer(recipient, dripAmount);
        if (!ok) revert TransferFailed();

        emit Dripped(recipient, dripAmount, block.timestamp + dripInterval);
    }

    // ============ Views ============

    /// @notice Current JINN balance held by the faucet.
    function balance() external view returns (uint256) {
        return jinn.balanceOf(address(this));
    }

    /// @notice Earliest timestamp at which `recipient` can drip again.
    /// @dev Returns 0 if the recipient has never dripped.
    function nextAvailableAt(address recipient) external view returns (uint256) {
        uint256 last = lastDripAt[recipient];
        if (last == 0) return 0;
        return last + dripInterval;
    }

    // ============ Admin ============

    /// @notice Update `dripAmount`. Owner only.
    function setDripAmount(uint256 newAmount) external {
        if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
        if (newAmount == 0) revert ZeroValue();
        uint256 old = dripAmount;
        dripAmount = newAmount;
        emit DripAmountUpdated(old, newAmount);
    }

    /// @notice Update `dripInterval`. Owner only.
    function setDripInterval(uint256 newInterval) external {
        if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
        if (newInterval == 0) revert ZeroValue();
        uint256 old = dripInterval;
        dripInterval = newInterval;
        emit DripIntervalUpdated(old, newInterval);
    }

    /// @notice Transfer ownership. Owner only.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
        if (newOwner == address(0)) revert ZeroAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    /// @notice Withdraw JINN from the faucet (migration / refund). Owner only.
    function withdraw(address to, uint256 amount) external {
        if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroValue();

        bool ok = jinn.transfer(to, amount);
        if (!ok) revert TransferFailed();

        emit Withdrawn(to, amount);
    }
}
